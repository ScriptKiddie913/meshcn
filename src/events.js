"use strict";

const crypto = require("crypto");
const db = require("./db");

const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO events
    (event_id, client_event_id, node_id, event_type, payload, signature, timestamp)
  VALUES (@event_id, @client_event_id, @node_id, @event_type, @payload, @signature, @timestamp)
`);

const sinceStmt = db.prepare(`
  SELECT global_seq, event_id, node_id, event_type, payload, signature, timestamp
  FROM events
  WHERE global_seq > ?
  ORDER BY global_seq ASC
  LIMIT 500
`);

const maxSeqStmt = db.prepare(`SELECT COALESCE(MAX(global_seq), 0) AS max_seq FROM events`);

/**
 * Append a single event to the store. `clientEventId` is used for
 * idempotency when a client re-submits during retry/reconnect.
 */
function appendEvent({ nodeId, eventType, payload, signature = null, clientEventId = null, timestamp = null }) {
  const row = {
    event_id: crypto.randomUUID(),
    client_event_id: clientEventId || crypto.randomUUID(),
    node_id: nodeId,
    event_type: eventType,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload || {}),
    signature,
    timestamp: timestamp || Date.now(),
  };
  const result = insertEventStmt.run(row);
  return { ...row, global_seq: result.lastInsertRowid, inserted: result.changes > 0 };
}

/** Bulk-append events a client is pushing during sync. Returns inserted rows. */
function appendEvents(nodeId, events) {
  const inserted = [];
  const tx = db.transaction((evts) => {
    for (const e of evts) {
      const row = appendEvent({
        nodeId,
        eventType: e.event_type,
        payload: e.payload,
        signature: e.signature || null,
        clientEventId: e.client_event_id || null,
        timestamp: e.timestamp || null,
      });
      if (row.inserted) inserted.push(row);
    }
  });
  tx(events);
  return inserted;
}

/** Events the server has beyond `sinceGlobalSeq` — what a reconnecting client is missing. */
function eventsSince(sinceGlobalSeq) {
  return sinceStmt.all(Number(sinceGlobalSeq) || 0);
}

function currentGlobalSeq() {
  return maxSeqStmt.get().max_seq;
}

module.exports = { appendEvent, appendEvents, eventsSince, currentGlobalSeq };
