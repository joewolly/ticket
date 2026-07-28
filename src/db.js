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

  `
  -- Reference material for a ticket: the forum thread that explained the
  -- error, the vendor RMA page, the runbook. Links rather than uploads, so
  -- there is still exactly one file to back up.
  CREATE TABLE ticket_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    url        TEXT    NOT NULL,
    label      TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_ticket_links_ticket ON ticket_links(ticket_id);

  -- Recurring maintenance: the work you only remember once it has already gone
  -- wrong. A schedule is a ticket template plus a cadence; the runner in
  -- api/schedules.js turns it into real tickets as they come due.
  CREATE TABLE schedules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT    NOT NULL,
    body           TEXT    NOT NULL DEFAULT '',
    priority       TEXT    NOT NULL DEFAULT 'medium',
    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    -- Tags are a template here, not a relation to query, so a normalized CSV
    -- is enough and avoids a join table that nothing would ever read.
    tags           TEXT    NOT NULL DEFAULT '',
    interval_days  INTEGER NOT NULL,
    lead_days      INTEGER NOT NULL DEFAULT 0,
    next_due       TEXT    NOT NULL,
    paused         INTEGER NOT NULL DEFAULT 0,
    last_run_at    TEXT,
    last_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_schedules_due ON schedules(paused, next_due);

  -- Lets a generated ticket point back at what generated it. Nullable with a
  -- NULL default, which is what makes adding a REFERENCES column by ALTER
  -- legal while foreign keys are enforced.
  ALTER TABLE tickets ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;

  CREATE INDEX idx_tickets_schedule ON tickets(schedule_id);

  -- Marks a ticket as already reported overdue, so the daily sweep announces
  -- each lapse once instead of every day until it is dealt with. Cleared when
  -- the due date moves, so a deferred ticket is announced again if it lapses.
  ALTER TABLE tickets ADD COLUMN overdue_notified_at TEXT;
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

/** Names savepoints uniquely; a plain counter is enough since it never resets. */
let savepointSeq = 0;

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * SQLite has no nested BEGIN, so a call made while a transaction is already
 * open joins it through a savepoint rather than failing. That is what lets a
 * composite operation — firing a schedule, which creates a ticket — compose
 * out of pieces that each insist on their own atomicity, without either side
 * having to know it is being wrapped.
 */
export function transaction(db, fn) {
  if (db.isTransaction) return savepoint(db, fn);

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

function savepoint(db, fn) {
  const name = `sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    // ROLLBACK TO rewinds without discarding the savepoint, so it still has to
    // be released or it would pin every later one beneath it.
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}
