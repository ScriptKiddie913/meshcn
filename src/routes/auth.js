"use strict";

const express = require("express");
const { createChallenge, verifyChallenge } = require("../auth");
const { signHandshakeChallenge } = require("../identity");

const router = express.Router();

router.post("/auth/challenge", express.json(), (req, res) => {
  const { node_id: nodeId } = req.body || {};
  if (!nodeId || typeof nodeId !== "string") {
    return res.status(400).json({ error: "node_id is required" });
  }

  const challenge = createChallenge(nodeId);
  const host = req.hostname || "sdmesh";
  const handshake = signHandshakeChallenge(challenge.nonce, host);

  res.json({
    ...challenge,
    server_epoch: handshake.epoch,
    server_pub: handshake.server_pub,
    server_sig: handshake.server_sig,
  });
});

router.post("/auth/verify", express.json(), (req, res) => {
  const { node_id: nodeId, nonce, signature } = req.body || {};
  if (!nodeId || !nonce || !signature) {
    return res.status(400).json({ error: "node_id, nonce, and signature are required" });
  }

  const host = req.hostname || "sdmesh";
  const session = verifyChallenge(nodeId, nonce, signature, host);
  if (!session) {
    return res.status(401).json({ error: "invalid_challenge_signature" });
  }

  res.json(session);
});

module.exports = router;
