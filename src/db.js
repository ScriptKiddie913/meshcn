"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATABASE_URL = process.env.DATABASE_URL || "./data/sdmesh.db";

// Make sure the directory for the db file exists (important for Render disks).
const dir = path.dirname(DATABASE_URL);
if (dir && dir !== "." && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DATABASE_URL);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    node_id     TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    public_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
  );

  -- Event store. global_seq is the canonical server-side ordering used for
  -- sync watermarks. Private keys are never stored here or anywhere else.
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
