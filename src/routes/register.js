"use strict";

const express = require("express");
const { issueToken } = require("../auth");
const { usernameTaken, nodeIdTaken, registerNode, listPeers } = require("../registry");
const { appendEvent, currentGlobalSeq } = require("../events");
const { broadcast } = require("../ws");

const router = express.Router();

const NODE_ID_RE = /^[a-zA-Z0-9._-]{4,128}$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

router.post("/register", express.json(), (req, res) => {
  const { username, node_id: nodeId, public_key: publicKey } = req.body || {};

  if (!username || !nodeId || !publicKey) {
    return res.status(400).json({ error: "username, node_id and public_key are required" });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "invalid username" });
  }
  if (!NODE_ID_RE.test(nodeId)) {
    return res.status(400).json({ error: "invalid node_id" });
  }
  if (typeof publicKey !== "string" || publicKey.length < 16) {
    return res.status(400).json({ error: "invalid public_key" });
  }
  if (usernameTaken(username)) {
    return res.status(409).json({ error: "username_taken" });
  }
  if (nodeIdTaken(nodeId)) {
    return res.status(409).json({ error: "node_id_taken" });
  }

  const node = registerNode({ nodeId, username, publicKey });

  appendEvent({
    nodeId,
    eventType: "USER_REGISTERED",
    payload: { username },
  });
  const keyEvent = appendEvent({
    nodeId,
    eventType: "KEY_REGISTERED",
    payload: { public_key: publicKey },
  });

  const token = issueToken(nodeId);
  const peers = listPeers();

  // Let already-connected clients know about the new node/public key.
  broadcast(
    { type: "peer_update", node: { node_id: nodeId, username, public_key: publicKey } },
    nodeId
  );

  res.status(201).json({
    node_id: node.node_id,
    token,
    peers,
    global_seq: currentGlobalSeq(),
    last_event_global_seq: keyEvent.global_seq,
  });
});

// Public peer list (auth required — token issued at /register).
router.get("/peers", require("../auth").requireAuth, (req, res) => {
  res.json({ peers: listPeers() });
});

module.exports = router;
