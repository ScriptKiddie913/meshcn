"use strict";

const db = require("./db");

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_MAILBOX_FETCH = 100;

// RAM-only mailbox mode (Addendum 9.2 / S7)
const isRamMode = process.env.MAILBOX_STORAGE === "ram" || process.env.RAM_ONLY_MAILBOX === "true";
const ramMailboxItems = new Map(); // mailboxId -> Map(msgId -> { id, mailbox_id, msg_id, envelope, created_at, expires_at })
let nextRamId = 1;

const insertItemStmt = db.prepare(`
  INSERT INTO mailbox_items (mailbox_id, msg_id, envelope, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(mailbox_id, msg_id) DO NOTHING
  RETURNING *
`);

const fetchItemsStmt = db.prepare(`
  SELECT id, mailbox_id, msg_id, envelope, created_at, expires_at
  FROM mailbox_items
  WHERE mailbox_id = ? AND expires_at > ?
  ORDER BY id ASC
  LIMIT ?
`);

const deleteItemStmt = db.prepare(`
  DELETE FROM mailbox_items WHERE mailbox_id = ? AND msg_id = ?
`);

const cleanExpiredStmt = db.prepare(`
  DELETE FROM mailbox_items WHERE expires_at <= ?
`);

const mapMailboxStmt = db.prepare(`
  INSERT OR IGNORE INTO node_mailboxes (node_id, mailbox_id, created_at)
  VALUES (?, ?, ?)
`);

const checkMailboxStmt = db.prepare(`
  SELECT 1 FROM node_mailboxes WHERE node_id = ? AND mailbox_id = ?
`);

const listNodeMailboxesStmt = db.prepare(`
  SELECT mailbox_id FROM node_mailboxes WHERE node_id = ?
`);

function storeMailboxItem({ mailboxId, msgId, envelope, ttlMs = DEFAULT_TTL_MS }) {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const envStr = typeof envelope === "string" ? envelope : JSON.stringify(envelope);

  if (isRamMode) {
    if (!ramMailboxItems.has(mailboxId)) {
      ramMailboxItems.set(mailboxId, new Map());
    }
    const box = ramMailboxItems.get(mailboxId);
    if (box.has(msgId)) {
      return { inserted: false, msg_id: msgId, mailbox_id: mailboxId };
    }
    const item = {
      id: nextRamId++,
      mailbox_id: mailboxId,
      msg_id: String(msgId),
      envelope: envStr,
      created_at: now,
      expires_at: expiresAt,
    };
    box.set(msgId, item);
    return { inserted: true, msg_id: msgId, mailbox_id: mailboxId };
  }

  const res = insertItemStmt.get(mailboxId, String(msgId), envStr, now, expiresAt);
  return {
    inserted: !!res,
    msg_id: msgId,
    mailbox_id: mailboxId,
  };
}

function fetchMailboxItems(mailboxId, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_MAILBOX_FETCH);
  const now = Date.now();

  if (isRamMode) {
    const box = ramMailboxItems.get(mailboxId);
    if (!box) return [];
    const items = [];
    for (const item of box.values()) {
      if (item.expires_at > now) {
        items.push(item);
        if (items.length >= safeLimit) break;
      }
    }
    return items;
  }

  return fetchItemsStmt.all(mailboxId, now, safeLimit);
}

function ackMailboxItems(mailboxId, msgIds) {
  if (!Array.isArray(msgIds) || msgIds.length === 0) return 0;
  let deletedCount = 0;

  if (isRamMode) {
    const box = ramMailboxItems.get(mailboxId);
    if (box) {
      for (const id of msgIds) {
        if (box.delete(String(id))) deletedCount++;
      }
    }
    return deletedCount;
  }

  const tx = db.transaction((ids) => {
    for (const msgId of ids) {
      deleteItemStmt.run(mailboxId, String(msgId));
      deletedCount++;
    }
  });
  tx(msgIds);
  return deletedCount;
}

function registerNodeMailbox(nodeId, mailboxId) {
  mapMailboxStmt.run(nodeId, mailboxId, Date.now());
}

function nodeOwnsMailbox(nodeId, mailboxId) {
  return !!checkMailboxStmt.get(nodeId, mailboxId);
}

function listNodeMailboxes(nodeId) {
  return listNodeMailboxesStmt.all(nodeId).map((r) => r.mailbox_id);
}

function cleanExpired() {
  const now = Date.now();
  if (isRamMode) {
    for (const [mbxId, box] of ramMailboxItems.entries()) {
      for (const [msgId, item] of box.entries()) {
        if (item.expires_at <= now) box.delete(msgId);
      }
      if (box.size === 0) ramMailboxItems.delete(mbxId);
    }
    return;
  }
  cleanExpiredStmt.run(now);
}

module.exports = {
  storeMailboxItem,
  fetchMailboxItems,
  ackMailboxItems,
  registerNodeMailbox,
  nodeOwnsMailbox,
  listNodeMailboxes,
  cleanExpired,
};
