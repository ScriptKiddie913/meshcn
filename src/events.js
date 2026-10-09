"use strict";

const crypto = require("crypto");
const db = require("./db");

const insertEventReturningStmt = db.prepare(`
  INSERT INTO events
    (event_id, client_event_id, node_id, event_type, payload, signature, timestamp)
  VALUES (@event_id, @client_event_id, @node_id, @event_type, @payload, @signature, @timestamp)
  ON CONFLICT(node_id, client_event_id) DO NOTHING
  RETURNING *
`);

const getByClientEventIdStmt = db.prepare(`
  SELECT * FROM events
  WHERE node_id = ? AND client_event_id = ?
`);

const sinceStmt = db.prepare(`
  SELECT global_seq, event_id, client_event_id, node_id, event_type, payload, signature, timestamp
  FROM events
  WHERE global_seq > ?
  ORDER BY global_seq ASC
  LIMIT ?
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
    signature: signature || null,
    timestamp: timestamp || Date.now(),
  };

  const insertedRow = insertEventReturningStmt.get({
    event_id: row.event_id,
    client_event_id: row.client_event_id,
    node_id: row.node_id,
    event_type: row.event_type,
    payload: row.payload,
    signature: row.signature,
    timestamp: row.timestamp,
  });

  if (insertedRow) {
    return { ...insertedRow, inserted: true };
  }

  // Duplicate: fetch the existing row so stale rowids are never returned
  const existing = getByClientEventIdStmt.get(row.node_id, row.client_event_id);
  if (existing) {
    return { ...existing, inserted: false };
  }

  // Fallback in case of unexpected state
  return { ...row, global_seq: null, inserted: false };
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

/** Paginated events beyond `sinceGlobalSeq` — returns { items, next_cursor, has_more }. */
function eventsSince(sinceGlobalSeq, limit = 500) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const rows = sinceStmt.all(Number(sinceGlobalSeq) || 0, safeLimit + 1);
  const hasMore = rows.length > safeLimit;
  const items = hasMore ? rows.slice(0, safeLimit) : rows;
  const nextCursor = items.length > 0 ? items[items.length - 1].global_seq : Number(sinceGlobalSeq) || 0;

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

function currentGlobalSeq() {
  return maxSeqStmt.get().max_seq;
}

module.exports = { appendEvent, appendEvents, eventsSince, currentGlobalSeq };
