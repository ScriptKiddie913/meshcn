"use strict";

const crypto = require("crypto");
const db = require("./db");

const insertInviteStmt = db.prepare(`
  INSERT INTO invites (code_hash, created_at, used, used_by)
  VALUES (?, ?, 0, NULL)
`);

const getInviteStmt = db.prepare(`
  SELECT * FROM invites WHERE code_hash = ? AND used = 0
`);

const markUsedStmt = db.prepare(`
  UPDATE invites SET used = 1, used_by = ? WHERE code_hash = ?
`);

function hashInvite(code) {
  return crypto.createHash("sha256").update(String(code).trim()).digest("hex");
}

function mintInvite() {
  const code = `sdmesh-invite-${crypto.randomBytes(16).toString("hex")}`;
  const codeHash = hashInvite(code);
  insertInviteStmt.run(codeHash, Date.now());
  return code;
}

function validateAndConsumeInvite(code, usedByNodeId) {
  if (!code) return false;
  const codeHash = hashInvite(code);
  const invite = getInviteStmt.get(codeHash);
  if (!invite) return false;
  markUsedStmt.run(usedByNodeId, codeHash);
  return true;
}

module.exports = {
  mintInvite,
  validateAndConsumeInvite,
  hashInvite,
};
