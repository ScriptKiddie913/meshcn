"use strict";

const crypto = require("crypto");
const db = require("./db");
const { getByIdStmt } = require("./registry");

const SERVER_SECRET = process.env.SERVER_SECRET;
if (process.env.NODE_ENV === "production" && (!SERVER_SECRET || SERVER_SECRET === "change-me-to-a-long-random-secret")) {
  throw new Error("[sdmesh] FATAL: Production startup requires a strong SERVER_SECRET environment variable.");
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Statements
const insertChallengeStmt = db.prepare(`
  INSERT INTO auth_challenges (nonce, node_id, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const getChallengeStmt = db.prepare(`
  SELECT * FROM auth_challenges WHERE nonce = ? AND node_id = ? AND expires_at > ?
`);
const deleteChallengeStmt = db.prepare(`DELETE FROM auth_challenges WHERE nonce = ?`);

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (token_hash, node_id, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const getSessionStmt = db.prepare(`
  SELECT * FROM sessions WHERE token_hash = ? AND node_id = ? AND expires_at > ?
`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Step 1 of Ed25519 auth: Issue a random challenge nonce
 */
function createChallenge(nodeId) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_MS;
  insertChallengeStmt.run(nonce, nodeId, now, expiresAt);
  return { nonce, expires_at: expiresAt };
}

/**
 * Step 2 of Ed25519 auth: Verify client's signature over the challenge
 */
function verifyChallenge(nodeId, nonce, signature, host = "sdmesh") {
  const challenge = getChallengeStmt.get(nonce, nodeId, Date.now());
  if (!challenge) return null;

  deleteChallengeStmt.run(nonce);

  const node = getByIdStmt.get(nodeId);
  if (!node) return null;

  // Unpack public key
  let signPubBase64 = null;
  try {
    const parsed = JSON.parse(node.public_key);
    signPubBase64 = parsed.sign || parsed.sign_pub;
  } catch {
    signPubBase64 = node.public_key;
  }

  if (!signPubBase64) return null;

  const expectedData = `sdmesh-auth-v2|${nonce}|${host}`;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(signPubBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const verified = crypto.verify(
      null,
      Buffer.from(expectedData, "utf8"),
      key,
      Buffer.from(signature, "base64")
    );
    if (!verified) return null;
  } catch {
    return null;
  }

  // Issue random 256-bit session token
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  insertSessionStmt.run(tokenHash, nodeId, now, expiresAt);

  return { token, expires_at: expiresAt };
}

/**
 * Verify a session token (constant-time / hash lookup)
 */
function verifyToken(nodeId, token) {
  if (!nodeId || !token) return false;

  // Check session token in sessions table
  const tokenHash = hashToken(token);
  const session = getSessionStmt.get(tokenHash, nodeId, Date.now());
  if (session) return true;

  // Fallback support for legacy HMAC during transition (if SERVER_SECRET set)
  if (SERVER_SECRET) {
    const legacyHmac = crypto.createHmac("sha256", SERVER_SECRET).update(nodeId).digest("hex");
    const a = Buffer.from(legacyHmac, "hex");
    const b = Buffer.from(String(token), "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}

function revokeSession(token) {
  deleteSessionStmt.run(hashToken(token));
}

function requireAuth(req, res, next) {
  const nodeId = req.header("x-node-id");
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!verifyToken(nodeId, token)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.nodeId = nodeId;
  next();
}

function issueToken(nodeId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  insertSessionStmt.run(tokenHash, nodeId, Date.now(), Date.now() + SESSION_TTL_MS);
  return token;
}

module.exports = {
  createChallenge,
  verifyChallenge,
  issueToken,
  verifyToken,
  revokeSession,
  requireAuth,
  hashToken,
};
