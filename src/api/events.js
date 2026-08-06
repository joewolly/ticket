/**
 * The ticket activity timeline. Every meaningful change to a ticket leaves a
 * row here, so "what did I do to this box, and when?" — the question the whole
 * app is built around — stays answerable without anyone having to have typed a
 * comment. Values are text snapshots taken at the moment of the change, never
 * foreign keys, so the log reads correctly even after a device is renamed.
 */

/**
 * Appends one event. Called from within the same transaction as the change it
 * describes, so a rolled-back update never leaves a phantom line in the log.
 */
export function recordEvent(db, ticketId, kind, from = null, to = null) {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, kind, from_value, to_value)
     VALUES (?, ?, ?, ?)`,
  ).run(ticketId, kind, from, to);
}

/** A ticket's events, oldest first, to sit alongside its comments. */
export function listEvents(db, ticketId) {
  return db
    .prepare(
      `SELECT id, kind, from_value, to_value, created_at
         FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(ticketId);
}

/**
 * Diffs a ticket against its previous state and records one event per field
 * that actually moved. `deviceName` resolves the numeric device_id to the name
 * shown in the log; the caller passes the before/after names it already has.
 */
export function recordChanges(db, ticketId, before, after, { deviceNames = {} } = {}) {
  const changed = (key) => Object.hasOwn(after, key) && after[key] !== before[key];

  if (changed('status')) {
    recordEvent(db, ticketId, 'status', before.status, after.status);
  }
  if (changed('priority')) {
    recordEvent(db, ticketId, 'priority', before.priority, after.priority);
  }
  if (changed('device_id')) {
    recordEvent(
      db,
      ticketId,
      'device',
      deviceNames.before ?? null,
      deviceNames.after ?? null,
    );
  }
  if (changed('due_date')) {
    recordEvent(db, ticketId, 'due_date', before.due_date, after.due_date);
  }
  if (changed('title')) {
    recordEvent(db, ticketId, 'title', before.title, after.title);
  }
}
