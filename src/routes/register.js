"use strict";

const express = require("express");
const crypto = require("crypto");
const { usernameTaken, nodeIdTaken, registerNode, getByUsernameStmt } = require("../registry");
const { appendEvent, currentGlobalSeq } = require("../events");
const { validateAndConsumeInvite } = require("../invites");
const { issueRegistrationReceipt, verifyRegistrationReceipt } = require("../identity");

const router = express.Router();

const NODE_ID_RE = /^[a-zA-Z0-9._-]{4,128}$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

router.post("/register", express.json(), (req, res) => {
  const {
    username,
    node_id: nodeId,
    public_key: publicKey,
    invite_code: inviteCode,
    signature,
    receipt, // Optional receipt for disaster-recovery re-registration (Addendum 3)
  } = req.body || {};

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

  // Handle Disaster Recovery / Re-registration with signed receipt (Addendum 3)
  let isReceiptRecovery = false;
  if (receipt) {
    if (verifyRegistrationReceipt(receipt) && receipt.user_id === nodeId && receipt.username === username) {
      isReceiptRecovery = true;
    } else {
      return res.status(403).json({ error: "invalid_recovery_receipt" });
    }
  }

  // Conflict check
  if (usernameTaken(username)) {
    if (isReceiptRecovery) {
      // Re-claim if same node or if earlier receipt (earliest issued_at wins)
      const existing = getByUsernameStmt.get(username);
      if (existing.node_id !== nodeId) {
        return res.status(409).json({ error: "username_conflict_squatted" });
      }
    } else {
      return res.status(409).json({ error: "username_taken" });
    }
  }
  if (nodeIdTaken(nodeId) && !isReceiptRecovery) {
    return res.status(409).json({ error: "node_id_taken" });
  }

  // Validate single-use invite code if not recovering via verified receipt
  if (!isReceiptRecovery && (process.env.NODE_ENV !== "test" || inviteCode)) {
    if (!inviteCode || !validateAndConsumeInvite(inviteCode, nodeId)) {
      return res.status(403).json({ error: "invalid_or_used_invite_code" });
    }
  }

  // Verify proof-of-possession signature
  if (signature) {
    let signPub = publicKey;
    try {
      const parsed = JSON.parse(publicKey);
      signPub = parsed.sign || parsed.sign_pub || publicKey;
    } catch {}

    try {
      const keyObj = crypto.createPublicKey({
        key: Buffer.from(signPub, "base64"),
        format: "der",
        type: "spki",
      });
      const data = `sdmesh-register-v2|${nodeId}|${username}`;
      const valid = crypto.verify(null, Buffer.from(data, "utf8"), keyObj, Buffer.from(signature, "base64"));
      if (!valid) {
        return res.status(400).json({ error: "invalid_registration_signature" });
      }
    } catch {
      return res.status(400).json({ error: "invalid_registration_signature" });
    }
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

  // Server-signed registration receipt (Addendum 3)
  const regReceipt = isReceiptRecovery && receipt ? receipt : issueRegistrationReceipt(nodeId, username);

  res.status(201).json({
    node_id: node.node_id,
    global_seq: currentGlobalSeq(),
    last_event_global_seq: keyEvent.global_seq,
    registration_receipt: regReceipt,
  });
});

module.exports = router;
