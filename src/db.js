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

  `
  -- An append-only record of what happened to a ticket and when: status moves,
  -- priority bumps, device reassignments, due-date shifts. Comments already
  -- capture what you *say*; this captures what you *do*, so a ticket that sat
  -- blocked for three weeks no longer looks identical to one fixed on the spot.
  -- 'from' and 'to' are text snapshots taken at the time, not foreign keys, so
  -- the log still reads correctly after a device is renamed or deleted.
  CREATE TABLE ticket_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    from_value TEXT,
    to_value   TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);

  -- Device lifecycle: the fields you reach for the moment something needs an
  -- RMA or a replacement budget. warranty_notified_at is the same
  -- announce-once marker the overdue sweep uses, so an expiring warranty opens
  -- exactly one ticket rather than one on every sweep.
  ALTER TABLE devices ADD COLUMN serial_number       TEXT;
  ALTER TABLE devices ADD COLUMN purchase_date       TEXT;
  ALTER TABLE devices ADD COLUMN warranty_expires    TEXT;
  ALTER TABLE devices ADD COLUMN cost                REAL;
  ALTER TABLE devices ADD COLUMN warranty_notified_at TEXT;

  -- What this device depends on: a VM on its host, everything on the switch it
  -- hangs off. Self-referential and nullable; ON DELETE SET NULL so removing a
  -- host orphans its guests rather than cascading them into oblivion.
  ALTER TABLE devices ADD COLUMN parent_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;

  CREATE INDEX idx_devices_parent ON devices(parent_id);

  -- The same announce-once marker for a due date approaching, distinct from the
  -- overdue one so a ticket can warn as it nears and again once it lapses. Both
  -- are cleared together when the due date moves.
  ALTER TABLE tickets ADD COLUMN due_soon_notified_at TEXT;

  -- Small key/value store for state that has nowhere better to live — currently
  -- just the timestamp of the last digest sent, so the weekly summary keeps its
  -- cadence across restarts.
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Full-text search over a ticket's title, body, and every comment on it, kept
  -- in step by triggers so the data layer never has to think about it. An
  -- ordinary (not external-content) FTS5 table, which means plain INSERT/DELETE
  -- by rowid work from triggers without the contentless-table command dance.
  CREATE VIRTUAL TABLE tickets_fts USING fts5(title, body, comments);

  INSERT INTO tickets_fts(rowid, title, body, comments)
    SELECT t.id, t.title, t.body,
           coalesce((SELECT group_concat(c.body, ' ') FROM comments c
                      WHERE c.ticket_id = t.id), '')
      FROM tickets t;

  CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
    INSERT INTO tickets_fts(rowid, title, body, comments)
      VALUES (new.id, new.title, new.body, '');
  END;

  CREATE TRIGGER tickets_fts_au AFTER UPDATE ON tickets BEGIN
    UPDATE tickets_fts SET title = new.title, body = new.body WHERE rowid = new.id;
  END;

  CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
    DELETE FROM tickets_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
    UPDATE tickets_fts
       SET comments = (SELECT group_concat(body, ' ') FROM comments
                        WHERE ticket_id = new.ticket_id)
     WHERE rowid = new.ticket_id;
  END;

  CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
    UPDATE tickets_fts
       SET comments = (SELECT coalesce(group_concat(body, ' '), '') FROM comments
                        WHERE ticket_id = old.ticket_id)
     WHERE rowid = old.ticket_id;
  END;

  -- Attachments live as BLOBs in the same file rather than on a separate disk,
  -- which is the whole point: there is still exactly one thing to back up, and
  -- VACUUM INTO snapshots the photo of the scorched capacitor along with the
  -- ticket that explains it. Size is capped at the request layer.
  CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    filename     TEXT    NOT NULL,
    content_type TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    data         BLOB    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_attachments_ticket ON attachments(ticket_id);
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
