import { transaction } from '../db.js';
import { createTicket, getTicket } from './tickets.js';
import { civilDate, addDays, timeZoneFor } from '../dates.js';
import { listEvents } from './events.js';
import {
  parseRecurrence,
  nextOccurrence,
  syncRecurrence,
} from '../recurrence.js';
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
  if (query.is_chore !== undefined && query.is_chore !== '') {
    where.push('s.is_chore = :is_chore');
    params.is_chore = boolean(query.is_chore, 'is_chore') ? 1 : 0;
  }
  if (query.archived !== undefined && query.archived !== '') {
    where.push('s.archived = :archived');
    params.archived = boolean(query.archived, 'archived') ? 1 : 0;
  }

  const sql = `${SELECT_SCHEDULE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.paused ASC, s.next_due ASC, s.title COLLATE NOCASE ASC`;

  return db.prepare(sql).all(params).map(shapeSchedule);
}

/**
 * Returns the durable two-person chore roster and assignments for one
 * Sunday–Saturday week. Reading a past week is deliberately read-only.
 */
export function getChoreRoster(db, { week, today: suppliedToday } = {}) {
  const today = rosterToday(db, suppliedToday);
  const weekStart = week === undefined || week === null
    ? sundayFor(today)
    : optionalDate(week, 'week');
  if (
    !weekStart ||
    new Date(`${weekStart}T12:00:00Z`).getUTCDay() !== 0
  )
    throw new ValidationError('week must be a Sunday in YYYY-MM-DD format');
  const weekEnd = addDays(weekStart, 6);

  const members = db
    .prepare('SELECT id, name FROM household_members ORDER BY id')
    .all()
    .map(({ id, name }) => ({ id, name }));
  const chores = db
    .prepare(`${SELECT_SCHEDULE} WHERE s.is_chore = 1 ORDER BY s.id`)
    .all()
    .map(shapeSchedule);
  const assignments = db
    .prepare(
      `SELECT t.id, t.schedule_id, t.assignee_id,
              m.name AS assignee_name, t.due_date, t.original_due_date,
              t.status, t.title,
              COALESCE(t.original_due_date, t.due_date) AS assignment_date
         FROM tickets t
         JOIN schedules s ON s.id = t.schedule_id AND s.is_chore = 1
         LEFT JOIN household_members m ON m.id = t.assignee_id
        WHERE (
          COALESCE(t.original_due_date, t.due_date) BETWEEN ? AND ?
          OR (COALESCE(t.original_due_date, t.due_date) < ?
              AND t.status NOT IN ('resolved', 'closed'))
        )
        ORDER BY assignment_date, t.id`,
    )
    .all(weekStart, weekEnd, weekStart)
    .map(({ assignment_date: _assignmentDate, ...row }) => ({
      ...row,
      events: listEvents(db, row.id),
    }));

  const previews = [];
  const minPreviewDate = weekStart === sundayFor(today) ? today : weekStart;
  for (const chore of chores) {
    if (chore.archived || chore.paused || !chore.recurrence) continue;
    const open = db
      .prepare(
        `SELECT id, due_date, original_due_date
           FROM tickets
          WHERE schedule_id = ? AND status NOT IN ('resolved', 'closed')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(chore.id);
    let dueDate;
    if (open) {
      if (chore.recurrence.kind === 'after_completion') continue;
      const anchor =
        open.original_due_date ?? open.due_date ?? chore.last_due ?? chore.next_due;
      dueDate = nextOccurrence(chore.recurrence, anchor, anchor);
    } else {
      dueDate = chore.next_due;
    }
    if (
      dueDate >= minPreviewDate &&
      dueDate >= weekStart &&
      dueDate <= weekEnd &&
      !db
        .prepare(
          'SELECT 1 FROM tickets WHERE schedule_id = ? AND original_due_date = ? LIMIT 1',
        )
        .get(chore.id, dueDate)
    ) {
      previews.push({
        schedule_id: chore.id,
        title: chore.title,
        due_date: dueDate,
        conditional: true,
      });
    }
  }

  return {
    members,
    chores,
    week_start: weekStart,
    week_end: weekEnd,
    assignments,
    previews,
    today,
  };
}

/** Updates the display name for one of the two stable household identities. */
export function updateHouseholdMember(db, id, { name } = {}) {
  const memberId = optionalId(id, 'id');
  if (![1, 2].includes(memberId))
    throw new NotFoundError(`No household member with id ${memberId}`);
  const memberName = requiredText(name, 'name', 100);
  if (!db.prepare('SELECT id FROM household_members WHERE id = ?').get(memberId))
    throw new NotFoundError(`No household member with id ${memberId}`);
  if (
    db
      .prepare('SELECT id FROM household_members WHERE name = ? AND id <> ?')
      .get(memberName, memberId)
  )
    throw new ValidationError('Household member names must be unique');
  db.prepare(
    "UPDATE household_members SET name = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(memberName, memberId);
  const member = db
    .prepare('SELECT id, name FROM household_members WHERE id = ?')
    .get(memberId);
  return { id: member.id, name: member.name };
}

/** The schedule plus the tickets it has generated, most recent first. */
export function getSchedule(db, id) {
  const row = db.prepare(`${SELECT_SCHEDULE} WHERE s.id = ?`).get(id);
  if (!row) throw new NotFoundError(`No schedule with id ${id}`);

  const tickets = db
    .prepare(
      `SELECT id, title, status, priority, due_date, resolved_at, created_at,
              assignee_id, original_due_date
         FROM tickets WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 20`,
    )
    .all(id);

  return { ...shapeSchedule(row), tickets };
}

export function createSchedule(db, input = {}) {
  const fields = parseSchedule(db, input, { partial: false });
  if (fields.is_chore && input.source_ticket_id)
    throw new ValidationError('Chores cannot be created from an existing ticket');
  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO schedules (${Object.keys(fields).join(',')}) VALUES (${Object.keys(
          fields,
        )
          .map((k) => ':' + k)
          .join(',')})`,
      )
      .run(fields);

    const id = Number(lastInsertRowid);
    if (input.source_ticket_id) {
      const ticket = getTicket(db, input.source_ticket_id);
      if (ticket.schedule_id)
        throw new ValidationError('Task already belongs to a schedule');
      if (!fields.recurrence)
        throw new ValidationError('Choose a recurrence rule');
      db.prepare('UPDATE tickets SET schedule_id = ? WHERE id = ?').run(
        id,
        ticket.id,
      );
      db.prepare(
        'UPDATE schedules SET last_ticket_id = ?, last_due = next_due WHERE id = ?',
      ).run(ticket.id, id);
      syncRecurrence(db, ticket.id);
    }
    return getSchedule(db, id);
  });
}

export function updateSchedule(db, id, input = {}) {
  const existing = getSchedule(db, id);
  if (
    Object.hasOwn(input, 'is_chore') &&
    boolean(input.is_chore, 'is_chore') !== existing.is_chore
  )
    throw new ValidationError('is_chore cannot be changed after schedule creation');
  if (
    existing.is_chore &&
    existing.archived &&
    Object.hasOwn(input, 'archived') &&
    !boolean(input.archived, 'archived')
  )
    throw new ValidationError('Archived chore schedules cannot be unarchived');

  const fields = parseSchedule(db, input, { partial: true, existing });
  const rule = Object.hasOwn(fields, 'recurrence')
    ? fields.recurrence && JSON.parse(fields.recurrence)
    : existing.recurrence;
  if (
    rule &&
    existing.last_ticket_id &&
    fields.next_due &&
    (fields.next_due !== existing.next_due ||
      JSON.stringify(rule) !== JSON.stringify(existing.recurrence))
  ) {
    // An edited start is the first eligible successor, not an occurrence
    // already consumed. Keep the current task's deadline/history unchanged.
    fields.last_due = addDays(
      fields.next_due,
      rule.kind === 'interval' ? -rule.days : -1,
    );
  }
  const keys = Object.keys(fields);
  if (keys.length === 0)
    throw new ValidationError('No updatable fields provided');

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
  const schedule = getSchedule(db, id);
  if (schedule.is_chore) {
    db.prepare(
      "UPDATE schedules SET archived = 1, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return;
  }
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
export function runSchedules(db, { today, onlyChores = false } = {}) {
  const injectedToday = today == null ? null : optionalDate(today, 'today');
  const choresOnly = boolean(onlyChores, 'onlyChores');
  const due = db
    .prepare(
      `SELECT * FROM schedules
        WHERE paused = 0 AND archived = 0 ${choresOnly ? 'AND is_chore = 1' : ''}
        ORDER BY next_due ASC, id ASC`,
    )
    .all();

  const fired = [];

  for (const schedule of due) {
    try {
      const date =
        injectedToday ??
        (schedule.is_chore
          ? civilDate(new Date(), timeZoneFor(db))
          : schedule.recurrence
            ? civilDate(new Date(), schedule.time_zone)
            : currentDate(db));
      if (schedule.is_chore) {
        const created = runChoreSchedule(db, schedule, date);
        if (created) fired.push(created);
        continue;
      }
      if (addDays(schedule.next_due, -schedule.lead_days) > date) continue;
      if (
        schedule.recurrence &&
        db
          .prepare(
            "SELECT 1 FROM tickets WHERE schedule_id = ? AND status NOT IN ('resolved','closed') LIMIT 1",
          )
          .get(schedule.id)
      )
        continue;
      if (schedule.recurrence && schedule.last_ticket_id) {
        const last = getTicket(db, schedule.last_ticket_id);
        if (last.is_open) continue;
        const rule = JSON.parse(schedule.recurrence);
        // Calendar routines skip missed dates after an outage. Completion-based
        // dates remain truly overdue, as their interval started at completion.
        if (rule.kind !== 'after_completion' && schedule.next_due < date) {
          schedule.next_due = nextOccurrence(
            rule,
            schedule.next_due,
            addDays(date, -1),
          );
          db.prepare('UPDATE schedules SET next_due = ? WHERE id = ?').run(
            schedule.next_due,
            schedule.id,
          );
          if (schedule.next_due > date) continue;
        }
      }
      fired.push(fire(db, schedule, date));
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

function fire(db, schedule, today, { assigneeId = null } = {}) {
  return transaction(db, () => {
    let ticket = createTicket(
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
        project_id: schedule.project_id,
      },
      { scheduleId: schedule.id },
    );
    if (schedule.is_chore) {
      const member = db
        .prepare('SELECT id, name FROM household_members WHERE id = ?')
        .get(assigneeId);
      if (!member) throw new Error(`No household member with id ${assigneeId}`);
      db.prepare(
        'UPDATE tickets SET assignee_id = ?, original_due_date = ? WHERE id = ?',
      ).run(member.id, schedule.next_due, ticket.id);
      db.prepare(
        `INSERT INTO ticket_events (ticket_id, kind, from_value, to_value)
         VALUES (?, 'assignee', NULL, ?)`,
      ).run(ticket.id, member.name);
    }
    JSON.parse(schedule.checklist).forEach((title, position) =>
      db
        .prepare(
          'INSERT INTO checklist_items(ticket_id,title,position) VALUES (?,?,?)',
        )
        .run(ticket.id, title, position),
    );
    if (schedule.is_chore) ticket = getTicket(db, ticket.id);

    db.prepare(
      `UPDATE schedules
          SET next_due = :next_due,
              last_due = :last_due,
              last_run_at = datetime('now'),
              last_ticket_id = :ticket_id,
              updated_at = datetime('now')
        WHERE id = :id`,
    ).run({
      id: schedule.id,
      last_due: schedule.next_due,
      ticket_id: ticket.id,
      next_due: schedule.recurrence
        ? schedule.next_due
        : advance(db, schedule.next_due, schedule.interval_days, today),
    });

    return { schedule_id: schedule.id, ticket };
  });
}

/** Materializes only a current-week chore occurrence; missed dates are skipped. */
function runChoreSchedule(db, staleSchedule, today) {
  const weekStart = sundayFor(today);
  const weekEnd = addDays(weekStart, 6);
  return transaction(db, () => {
    const schedule = db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(staleSchedule.id);
    if (!schedule || schedule.archived || schedule.paused) return null;
    if (!schedule.recurrence)
      throw new ValidationError(`Chore schedule ${schedule.id} needs recurrence`);
    if (
      db
        .prepare(
          "SELECT 1 FROM tickets WHERE schedule_id = ? AND status NOT IN ('resolved','closed') LIMIT 1",
        )
        .get(schedule.id)
    )
      return null;

    let dueDate = schedule.next_due;
    if (dueDate < today) {
      dueDate = nextOccurrence(
        JSON.parse(schedule.recurrence),
        dueDate,
        addDays(today, -1),
      );
      db.prepare(
        "UPDATE schedules SET next_due = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(dueDate, schedule.id);
      schedule.next_due = dueDate;
    }
    if (dueDate < today || dueDate < weekStart || dueDate > weekEnd) return null;
    if (
      db
        .prepare(
          'SELECT 1 FROM tickets WHERE schedule_id = ? AND original_due_date = ? LIMIT 1',
        )
        .get(schedule.id, dueDate)
    )
      return null;

    const assigneeId = chooseAssignee(db, schedule.id, weekStart, weekEnd);
    return fire(db, schedule, today, { assigneeId });
  });
}

/** Balances weekly work first, then avoids the schedule's last actual assignee. */
function chooseAssignee(db, scheduleId, weekStart, weekEnd) {
  const lookback = addDays(weekStart, -28);
  const lookbackEnd = addDays(weekStart, -1);
  const weekNumber = Math.floor(
    Date.parse(`${weekStart}T12:00:00Z`) / (7 * 24 * 60 * 60 * 1000),
  );
  const fairTieMemberId = (((weekNumber + scheduleId) % 2 + 2) % 2) + 1;
  const load = new Map(
    db
      .prepare(
        `SELECT assignee_id,
                SUM(CASE
                  WHEN COALESCE(original_due_date, due_date) BETWEEN ? AND ?
                    OR (COALESCE(original_due_date, due_date) < ?
                        AND status NOT IN ('resolved', 'closed'))
                  THEN 1 ELSE 0 END) AS week_count,
                SUM(CASE
                  WHEN COALESCE(original_due_date, due_date) BETWEEN ? AND ?
                  THEN 1 ELSE 0 END) AS recent_count
           FROM tickets
          WHERE assignee_id IS NOT NULL
          GROUP BY assignee_id`,
      )
      .all(weekStart, weekEnd, weekStart, lookback, lookbackEnd)
      .map((row) => [row.assignee_id, row]),
  );
  const previous = db
    .prepare(
      `SELECT assignee_id FROM tickets
        WHERE schedule_id = ? AND assignee_id IS NOT NULL
        ORDER BY COALESCE(original_due_date, due_date) DESC, id DESC LIMIT 1`,
    )
    .get(scheduleId)?.assignee_id;
  const members = db
    .prepare('SELECT id FROM household_members ORDER BY id')
    .all();
  if (members.length !== 2)
    throw new Error('The chore roster must contain exactly two members');
  members.sort((a, b) => {
    const aLoad = load.get(a.id) ?? { week_count: 0, recent_count: 0 };
    const bLoad = load.get(b.id) ?? { week_count: 0, recent_count: 0 };
    return (
      aLoad.week_count - bLoad.week_count ||
      Number(a.id === previous) - Number(b.id === previous) ||
      aLoad.recent_count - bLoad.recent_count ||
      Number(b.id === fairTieMemberId) - Number(a.id === fairTieMemberId) ||
      a.id - b.id
    );
  });
  return members[0].id;
}

/** Walks forward by whole intervals until the date is in the future. */
function advance(db, from, intervalDays, today) {
  // Validation keeps this above zero, so reaching here means the row was
  // corrupted or edited outside the API. Caught rather than looped over.
  if (!(intervalDays >= 1)) {
    throw new Error(
      `schedule interval must be at least 1 day, got ${intervalDays}`,
    );
  }

  const step = db.prepare(`SELECT date(?, ?) AS next`);
  let next = from;

  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    next = step.get(next, `+${intervalDays} days`).next;
    if (next > today) return next;
  }
  throw new Error(
    `schedule interval ${intervalDays} did not reach a future date`,
  );
}

function parseSchedule(db, input, { partial, existing = null }) {
  const fields = {};
  const has = (key) => Object.hasOwn(input, key);

  if (!partial || has('title'))
    fields.title = requiredText(input.title, 'title', 200);
  if (!partial || has('body')) fields.body = bodyText(input.body, 'body');
  if (!partial || has('priority')) {
    fields.priority = oneOf(input.priority, PRIORITIES, 'priority', 'medium');
  }
  if (!partial || has('device_id'))
    fields.device_id = optionalId(input.device_id, 'device_id');
  if (!partial || has('tags'))
    fields.tags = (tagList(input.tags) ?? []).join(',');
  if (!partial || has('paused'))
    fields.paused = boolean(input.paused, 'paused') ? 1 : 0;
  if (!partial || has('is_chore'))
    fields.is_chore = boolean(
      input.is_chore,
      'is_chore',
      Boolean(existing?.is_chore),
    )
      ? 1
      : 0;
  if (!partial || has('archived'))
    fields.archived = boolean(
      input.archived,
      'archived',
      Boolean(existing?.archived),
    )
      ? 1
      : 0;

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
    fields.next_due =
      optionalDate(input.next_due, 'next_due') ?? currentDate(db);
  }

  if (fields.device_id) assertDeviceExists(db, fields.device_id);
  if (!partial || has('recurrence'))
    fields.recurrence =
      input.recurrence == null
        ? null
        : JSON.stringify(parseRecurrence(input.recurrence));
  if (!partial || has('project_id'))
    fields.project_id = optionalId(input.project_id, 'project_id');
  if (
    fields.project_id &&
    !db.prepare('SELECT id FROM projects WHERE id = ?').get(fields.project_id)
  )
    throw new ValidationError('Project does not exist');
  if (!partial || has('checklist')) {
    const items = input.checklist ?? [];
    if (!Array.isArray(items) || items.length > 200)
      throw new ValidationError('Checklist must contain at most 200 items');
    fields.checklist = JSON.stringify(
      items.map((t) => requiredText(t, 'checklist item', 500)),
    );
  }
  const isChore = fields.is_chore ?? Number(existing?.is_chore ?? 0);
  if (!partial || has('time_zone')) {
    const applicationTimeZone = timeZoneFor(db);
    if (
      isChore &&
      input.time_zone != null &&
      input.time_zone !== applicationTimeZone
    )
      throw new ValidationError(
        `Chore time_zone must match the application time zone (${applicationTimeZone})`,
      );
    fields.time_zone =
      input.time_zone ??
      (isChore || input.recurrence ? applicationTimeZone : 'UTC');
    try {
      civilDate(new Date(), fields.time_zone);
    } catch {
      throw new ValidationError('Invalid time zone');
    }
  }
  const rule = Object.hasOwn(fields, 'recurrence')
    ? fields.recurrence
    : existing?.recurrence
      ? JSON.stringify(existing.recurrence)
      : null;
  if (isChore && !rule)
    throw new ValidationError('Chore schedules require a modern recurrence rule');
  if (isChore) fields.lead_days = 0;
  if (rule) {
    fields.lead_days = 0;
    if (!partial || has('next_due') || has('recurrence')) {
      const start = fields.next_due ?? existing.next_due;
      const parsed = JSON.parse(rule);
      fields.next_due = ['interval', 'after_completion'].includes(parsed.kind)
        ? start
        : nextOccurrence(parsed, start, addDays(start, -1));
    }
    if (!partial && !input.next_due)
      fields.next_due = ['interval', 'after_completion'].includes(
        JSON.parse(rule).kind,
      )
        ? civilDate(new Date(), fields.time_zone)
        : nextOccurrence(
            JSON.parse(rule),
            civilDate(new Date(), fields.time_zone),
            addDays(civilDate(new Date(), fields.time_zone), -1),
          );
  } else assertLeadFitsInterval(fields, existing);

  return fields;
}

/**
 * A lead time at or beyond the interval would make the schedule due again the
 * instant it fires, generating a ticket on every tick forever. On a PATCH the
 * untouched side of the pair comes from the stored row, so raising lead_days
 * alone is still checked against the interval already in force.
 */
function assertLeadFitsInterval(fields, existing) {
  if (
    !Object.hasOwn(fields, 'lead_days') &&
    !Object.hasOwn(fields, 'interval_days')
  )
    return;

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
const currentDate = (db) =>
  db.prepare(`SELECT date('now') AS today`).get().today;

function shapeSchedule({
  tags,
  paused,
  recurrence,
  checklist,
  is_chore,
  archived,
  ...schedule
}) {
  return {
    ...schedule,
    tags: splitTags(tags),
    paused: Boolean(paused),
    is_chore: Boolean(is_chore),
    archived: Boolean(archived),
    recurrence: recurrence ? JSON.parse(recurrence) : null,
    checklist: JSON.parse(checklist),
  };
}

function rosterToday(db, suppliedToday) {
  if (suppliedToday instanceof Date) {
    if (Number.isNaN(suppliedToday.getTime()))
      throw new ValidationError('today must be a valid date');
    return civilDate(suppliedToday, timeZoneFor(db));
  }
  if (suppliedToday !== undefined && suppliedToday !== null) {
    const value = optionalDate(suppliedToday, 'today');
    if (value === null) throw new ValidationError('today must be a valid date');
    return value;
  }
  return civilDate(new Date(), timeZoneFor(db));
}

function sundayFor(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -day);
}
