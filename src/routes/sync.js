"use strict";

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");
const { appendEvents, eventsSince, currentGlobalSeq } = require("../events");
const { touch } = require("../registry");
const { broadcast } = require("../ws");

const router = express.Router();

const getBackupStmt = db.prepare(`SELECT blob, updated_at FROM backups WHERE node_id = ?`);
const upsertBackupStmt = db.prepare(`
  INSERT INTO backups (node_id, blob, updated_at) VALUES (@node_id, @blob, @updated_at)
  ON CONFLICT(node_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at
`);

/**
 * POST /sync
 * body: { since_global_seq: number, new_events: [{ client_event_id, event_type, payload, signature, timestamp }] }
 *
 * Accepts events the client has that the server is missing, and returns
 * events the server has that the client is missing (based on the client's
 * last known global_seq watermark). This is how server recovery works after
 * a Render outage: the client reports what it has, the server fills the gap.
 */
router.post("/sync", requireAuth, express.json({ limit: "2mb" }), (req, res) => {
  const nodeId = req.nodeId;
  const { since_global_seq: since = 0, new_events: newEvents = [] } = req.body || {};

  touch(nodeId);

  let inserted = [];
  if (Array.isArray(newEvents) && newEvents.length > 0) {
    inserted = appendEvents(nodeId, newEvents.slice(0, 500));
    if (inserted.length > 0) {
      broadcast({ type: "sync_events", events: inserted }, nodeId);
    }
  }

  const missingEvents = eventsSince(since);

  res.json({
    accepted: inserted.map((e) => e.client_event_id),
    missing_events: missingEvents,
    global_seq: currentGlobalSeq(),
  });
});

// Server-side encrypted backup (opaque blob — server cannot read plaintext).
router.put("/backup", requireAuth, express.json({ limit: "10mb" }), (req, res) => {
  const { blob } = req.body || {};
  if (typeof blob !== "string" || blob.length === 0) {
    return res.status(400).json({ error: "blob (string) is required" });
  }
  upsertBackupStmt.run({ node_id: req.nodeId, blob, updated_at: Date.now() });
  res.json({ status: "ok" });
});

router.get("/backup", requireAuth, (req, res) => {
  const row = getBackupStmt.get(req.nodeId);
  if (!row) return res.status(404).json({ error: "no_backup" });
  res.json(row);
});

module.exports = router;
