import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Schema migrations, applied in order. The index in this array is the
 * schema version, tracked via SQLite's `user_version` pragma, so each
 * migration runs exactly once per database file.
 */
const MIGRATIONS = [
  `
  CREATE TABLE devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    type        TEXT    NOT NULL DEFAULT 'other',
    status      TEXT    NOT NULL DEFAULT 'active',
    hostname    TEXT,
    ip_address  TEXT,
    location    TEXT,
    os          TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'open',
    priority    TEXT    NOT NULL DEFAULT 'medium',
    device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    due_date    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE
  );

  CREATE TABLE ticket_tags (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
  );

  CREATE INDEX idx_tickets_status    ON tickets(status);
  CREATE INDEX idx_tickets_device    ON tickets(device_id);
  CREATE INDEX idx_tickets_priority  ON tickets(priority);
  CREATE INDEX idx_comments_ticket   ON comments(ticket_id);
  CREATE INDEX idx_ticket_tags_tag   ON ticket_tags(tag_id);
  `,

  `
  -- Only the SHA-256 of each session token is stored, so a leaked database
  -- file does not hand over usable sessions.
  CREATE TABLE sessions (
    token_hash  TEXT    PRIMARY KEY,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT    NOT NULL,
    user_agent  TEXT
  );

  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  `,
];

/**
 * Opens the database, enabling foreign keys and WAL, and brings the schema
 * up to date. Pass ':memory:' for an ephemeral database (used by tests).
 */
export function openDatabase(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    // WAL survives restarts and lets reads proceed during writes. It is not
    // supported for in-memory databases, hence the guard.
    db.exec('PRAGMA journal_mode = WAL');
  }

  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      // Pragmas do not accept bound parameters; version is a loop counter we
      // control, never user input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed: ${err.message}`, { cause: err });
    }
  }
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
