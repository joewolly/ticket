import { transaction } from '../db.js';
import { createTicket } from './tickets.js';
import { log, errorFields } from '../log.js';
import {
  PRIORITIES,
  NotFoundError,
  ValidationError,
  bodyText,
  boolean,
  boundedInt,
  oneOf,
  optionalDate,
  optionalId,
  requiredText,
  tagList,
} from '../validate.js';

/** Stops a corrupt interval from spinning the catch-up loop forever. */
const MAX_CATCHUP_STEPS = 10_000;

const SELECT_SCHEDULE = `
  SELECT s.*,
         d.name AS device_name,
         CAST(julianday(s.next_due) - julianday(date('now')) AS INTEGER) AS due_in_days
    FROM schedules s
    LEFT JOIN devices d ON d.id = s.device_id
`;

export function listSchedules(db, query = {}) {
  const where = [];
  const params = {};

  if (query.device_id) {
    where.push('s.device_id = :device_id');
    params.device_id = optionalId(query.device_id, 'device_id');
  }
  if (query.paused !== undefined && query.paused !== '') {
    where.push('s.paused = :paused');
    params.paused = boolean(query.paused, 'paused') ? 1 : 0;
  }

  const sql = `${SELECT_SCHEDULE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.paused ASC, s.next_due ASC, s.title COLLATE NOCASE ASC`;

  return db.prepare(sql).all(params).map(shapeSchedule);
}

/** The schedule plus the tickets it has generated, most recent first. */
export function getSchedule(db, id) {
  const row = db.prepare(`${SELECT_SCHEDULE} WHERE s.id = ?`).get(id);
  if (!row) throw new NotFoundError(`No schedule with id ${id}`);

  const tickets = db
    .prepare(
      `SELECT id, title, status, priority, due_date, resolved_at, created_at
         FROM tickets WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 20`,
    )
    .all(id);

  return { ...shapeSchedule(row), tickets };
}

export function createSchedule(db, input = {}) {
  const fields = parseSchedule(db, input, { partial: false });

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO schedules
         (title, body, priority, device_id, tags, interval_days, lead_days, next_due, paused)
       VALUES
         (:title, :body, :priority, :device_id, :tags, :interval_days, :lead_days, :next_due, :paused)`,
    )
    .run(fields);

  return getSchedule(db, Number(lastInsertRowid));
}

export function updateSchedule(db, id, input = {}) {
  const existing = getSchedule(db, id);

  const fields = parseSchedule(db, input, { partial: true, existing });
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new ValidationError('No updatable fields provided');

  const assignments = keys.map((key) => `${key} = :${key}`).join(', ');
  db.prepare(
    `UPDATE schedules SET ${assignments}, updated_at = datetime('now') WHERE id = :id`,
  ).run({ ...fields, id });

  return getSchedule(db, id);
}

/**
 * Deletes a schedule. Tickets it generated are kept and unlinked by the
 * schema's ON DELETE SET NULL — the same reasoning as deleting a device.
 */
export function deleteSchedule(db, id) {
  getSchedule(db, id);
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

/**
 * Materializes a ticket for every schedule that has come due, then advances
 * each one to its next occurrence.
 *
 * A schedule that fell behind while the box was off generates **one** ticket,
 * not one per missed interval: coming back from a month of downtime to thirty
 * identical "check the disks" tickets would be noise, and the single ticket
 * carries the original — genuinely overdue — due date, so nothing is hidden.
 *
 * Returns what it created, which is what the notifier reports on.
 */
export function runSchedules(db, { today = currentDate(db) } = {}) {
  const due = db
    .prepare(
      `SELECT * FROM schedules
        WHERE paused = 0
          AND date(next_due, '-' || lead_days || ' days') <= :today
        ORDER BY next_due ASC, id ASC`,
    )
    .all({ today });

  const fired = [];

  for (const schedule of due) {
    try {
      fired.push(fire(db, schedule, today));
    } catch (err) {
      // One malformed schedule must not stop the rest of the sweep.
      log.error('schedule failed to fire', {
        schedule_id: schedule.id,
        ...errorFields(err),
      });
    }
  }

  return fired;
}

function fire(db, schedule, today) {
  return transaction(db, () => {
    const ticket = createTicket(
      db,
      {
        title: schedule.title,
        body: schedule.body,
        priority: schedule.priority,
        // A device deleted since the schedule was written leaves device_id
        // NULL, which createTicket accepts.
        device_id: schedule.device_id,
        due_date: schedule.next_due,
        tags: splitTags(schedule.tags),
      },
      { scheduleId: schedule.id },
    );

    db.prepare(
      `UPDATE schedules
          SET next_due = :next_due,
              last_run_at = datetime('now'),
              last_ticket_id = :ticket_id,
              updated_at = datetime('now')
        WHERE id = :id`,
    ).run({
      id: schedule.id,
      ticket_id: ticket.id,
      next_due: advance(db, schedule.next_due, schedule.interval_days, today),
    });

    return { schedule_id: schedule.id, ticket };
  });
}

/** Walks forward by whole intervals until the date is in the future. */
function advance(db, from, intervalDays, today) {
  // Validation keeps this above zero, so reaching here means the row was
  // corrupted or edited outside the API. Caught rather than looped over.
  if (!(intervalDays >= 1)) {
    throw new Error(`schedule interval must be at least 1 day, got ${intervalDays}`);
  }

  const step = db.prepare(`SELECT date(?, ?) AS next`);
  let next = from;

  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    next = step.get(next, `+${intervalDays} days`).next;
    if (next > today) return next;
  }
  throw new Error(`schedule interval ${intervalDays} did not reach a future date`);
}

function parseSchedule(db, input, { partial, existing = null }) {
  const fields = {};
  const has = (key) => Object.hasOwn(input, key);

  if (!partial || has('title')) fields.title = requiredText(input.title, 'title', 200);
  if (!partial || has('body')) fields.body = bodyText(input.body, 'body');
  if (!partial || has('priority')) {
    fields.priority = oneOf(input.priority, PRIORITIES, 'priority', 'medium');
  }
  if (!partial || has('device_id')) fields.device_id = optionalId(input.device_id, 'device_id');
  if (!partial || has('tags')) fields.tags = (tagList(input.tags) ?? []).join(',');
  if (!partial || has('paused')) fields.paused = boolean(input.paused, 'paused') ? 1 : 0;

  if (!partial || has('interval_days')) {
    fields.interval_days = boundedInt(input.interval_days, 'interval_days', {
      min: 1,
      max: 3650,
      fallback: partial ? undefined : 30,
    });
  }
  if (!partial || has('lead_days')) {
    fields.lead_days = boundedInt(input.lead_days, 'lead_days', {
      min: 0,
      max: 365,
      fallback: 0,
    });
  }
  if (!partial || has('next_due')) {
    // Defaulting to today means a new schedule proves itself on the next tick
    // instead of going quiet until its first interval elapses.
    fields.next_due = optionalDate(input.next_due, 'next_due') ?? currentDate(db);
  }

  if (fields.device_id) assertDeviceExists(db, fields.device_id);
  assertLeadFitsInterval(fields, existing);

  return fields;
}

/**
 * A lead time at or beyond the interval would make the schedule due again the
 * instant it fires, generating a ticket on every tick forever. On a PATCH the
 * untouched side of the pair comes from the stored row, so raising lead_days
 * alone is still checked against the interval already in force.
 */
function assertLeadFitsInterval(fields, existing) {
  if (!Object.hasOwn(fields, 'lead_days') && !Object.hasOwn(fields, 'interval_days')) return;

  const lead = fields.lead_days ?? existing?.lead_days ?? 0;
  const interval = fields.interval_days ?? existing?.interval_days ?? Infinity;

  if (lead >= interval) {
    throw new ValidationError('lead_days must be smaller than interval_days');
  }
}

function assertDeviceExists(db, deviceId) {
  const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId);
  if (!exists) throw new ValidationError(`No device with id ${deviceId}`);
}

const splitTags = (csv) => (csv ? csv.split(',').filter(Boolean) : []);

/** SQLite's idea of today (UTC), so every date comparison uses one clock. */
const currentDate = (db) => db.prepare(`SELECT date('now') AS today`).get().today;

function shapeSchedule({ tags, paused, ...schedule }) {
  return { ...schedule, tags: splitTags(tags), paused: Boolean(paused) };
}
