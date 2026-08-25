"use strict";

const db = require("./db");

const insertNodeStmt = db.prepare(`
  INSERT INTO nodes (node_id, username, public_key, created_at, last_seen)
  VALUES (@node_id, @username, @public_key, @created_at, @created_at)
`);

const getByIdStmt = db.prepare(`SELECT * FROM nodes WHERE node_id = ?`);
const getByUsernameStmt = db.prepare(`SELECT * FROM nodes WHERE username = ?`);
const listPeersStmt = db.prepare(
  `SELECT node_id, username, public_key, last_seen FROM nodes ORDER BY created_at ASC`
);
const touchStmt = db.prepare(`UPDATE nodes SET last_seen = ? WHERE node_id = ?`);

function usernameTaken(username) {
  return !!getByUsernameStmt.get(username);
}

function nodeIdTaken(nodeId) {
  return !!getByIdStmt.get(nodeId);
}

function registerNode({ nodeId, username, publicKey }) {
  insertNodeStmt.run({
    node_id: nodeId,
    username,
    public_key: publicKey,
    created_at: Date.now(),
  });
  return getByIdStmt.get(nodeId);
}

function listPeers() {
  return listPeersStmt.all();
}

function touch(nodeId) {
  touchStmt.run(Date.now(), nodeId);
}

module.exports = { usernameTaken, nodeIdTaken, registerNode, listPeers, touch, getByIdStmt };
