"use strict";

const crypto = require("crypto");

const SERVER_SECRET = process.env.SERVER_SECRET;
if (!SERVER_SECRET || SERVER_SECRET === "change-me-to-a-long-random-secret") {
  // eslint-disable-next-line no-console
  console.warn(
    "[sdmesh] WARNING: SERVER_SECRET is not set to a strong value. " +
      "Set a long random SERVER_SECRET env var on Render before going live."
  );
}

/**
 * Issue an opaque bearer token for a node. This authenticates "this request
 * came from a node that completed registration" — it is NOT a substitute for
 * the client's own private key, which never leaves the client.
 */
function issueToken(nodeId) {
  const hmac = crypto.createHmac("sha256", SERVER_SECRET || "insecure-dev-secret");
  hmac.update(nodeId);
  return hmac.digest("hex");
}

function verifyToken(nodeId, token) {
  if (!nodeId || !token) return false;
  const expected = issueToken(nodeId);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(token), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Express middleware: expects `x-node-id` and `Authorization: Bearer <token>` headers. */
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

module.exports = { issueToken, verifyToken, requireAuth };
