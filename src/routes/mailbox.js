"use strict";

const express = require("express");
const { requireAuth } = require("../auth");
const {
  storeMailboxItem,
  fetchMailboxItems,
  ackMailboxItems,
  registerNodeMailbox,
  nodeOwnsMailbox,
} = require("../mailbox");

const router = express.Router();

// Register a mailbox capability for the caller
router.post("/mailbox/register", requireAuth, express.json(), (req, res) => {
  const { mailbox_id: mailboxId } = req.body || {};
  if (!mailboxId || typeof mailboxId !== "string") {
    return res.status(400).json({ error: "mailbox_id is required" });
  }

  registerNodeMailbox(req.nodeId, mailboxId);
  res.json({ status: "ok", mailbox_id: mailboxId });
});

// Deposit into mailbox (write capability - sender doesn't even need to be the owner)
router.put("/mailbox/:id", express.json({ limit: "1mb" }), (req, res) => {
  const mailboxId = req.params.id;
  const { msg_id: msgId, envelope } = req.body || {};

  if (!msgId || !envelope) {
    return res.status(400).json({ error: "msg_id and envelope are required" });
  }

  const result = storeMailboxItem({
    mailboxId,
    msgId: String(msgId),
    envelope,
  });

  res.status(result.inserted ? 201 : 200).json(result);
});

// Fetch items from mailbox (read capability - requires authentication and ownership)
router.get("/mailbox/:id", requireAuth, (req, res) => {
  const mailboxId = req.params.id;
  const limit = req.query.limit || 50;

  // Authorization check (S1)
  if (!nodeOwnsMailbox(req.nodeId, mailboxId)) {
    return res.status(403).json({ error: "unauthorized_for_mailbox" });
  }

  const items = fetchMailboxItems(mailboxId, limit);
  res.json({ items });
});

// Acknowledge and delete processed items (S7)
router.post("/mailbox/:id/ack", requireAuth, express.json(), (req, res) => {
  const mailboxId = req.params.id;
  const { msg_ids: msgIds } = req.body || {};

  if (!nodeOwnsMailbox(req.nodeId, mailboxId)) {
    return res.status(403).json({ error: "unauthorized_for_mailbox" });
  }

  const deletedCount = ackMailboxItems(mailboxId, msgIds);
  res.json({ status: "ok", deleted: deletedCount });
});

module.exports = router;
