"use strict";

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATABASE_URL = process.env.DATABASE_URL || "./data/sdmesh.db";

// Make sure the directory for the db file exists (important for Render disks).
const dir = path.dirname(DATABASE_URL);
if (dir && dir !== "." && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(DATABASE_URL);
db.exec("PRAGMA journal_mode = WAL;");

// Compatibility helpers for transaction and pragma
db.pragma = (sql) => db.exec(`PRAGMA ${sql};`);
db.transaction = (fn) => (...args) => {
  db.exec("BEGIN;");
  try {
    const res = fn(...args);
    db.exec("COMMIT;");
    return res;
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    node_id     TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    public_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
  );

  -- Phase 1: Authentication & Sessions
  CREATE TABLE IF NOT EXISTS invites (
    code_hash   TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    used_by     TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce       TEXT PRIMARY KEY,
    node_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    node_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id);

  -- Phase 1: Per-recipient Mailboxes (S1)
  CREATE TABLE IF NOT EXISTS mailbox_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox_id  TEXT NOT NULL,
    msg_id      TEXT NOT NULL,
    envelope    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    UNIQUE(mailbox_id, msg_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mailbox_id ON mailbox_items(mailbox_id);
  CREATE INDEX IF NOT EXISTS idx_mailbox_expires ON mailbox_items(expires_at);

  -- Mailbox ownership mapping
  CREATE TABLE IF NOT EXISTS node_mailboxes (
    node_id     TEXT NOT NULL,
    mailbox_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY(node_id, mailbox_id)
  );

  -- Public Key / Registration log only (non-sensitive)
  CREATE TABLE IF NOT EXISTS events (
    global_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL,
    client_event_id TEXT,
    node_id         TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload         TEXT NOT NULL,
    signature       TEXT,
    timestamp       INTEGER NOT NULL,
    UNIQUE(node_id, client_event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_events_global_seq ON events(global_seq);
  CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id);

  -- Encrypted server-side backup blobs (opaque to the server).
  CREATE TABLE IF NOT EXISTS backups (
    node_id     TEXT PRIMARY KEY,
    blob        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

module.exports = db;
