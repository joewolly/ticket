import { civilDate, addDays } from './dates.js';
import { ValidationError, boundedInt } from './validate.js';

export function parseRecurrence(rule) {
  if (rule === null) return null;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule))
    throw new ValidationError('Invalid recurrence');
  if (['interval', 'after_completion'].includes(rule.kind))
    return {
      kind: rule.kind,
      days: boundedInt(rule.days, 'days', { min: 1, max: 3650 }),
    };
  if (rule.kind === 'weekly') {
    if (
      !Array.isArray(rule.weekdays) ||
      !rule.weekdays.length ||
      rule.weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)
    )
      throw new ValidationError(
        'Select weekdays (0 = Sunday through 6 = Saturday)',
      );
    return { kind: rule.kind, weekdays: [...new Set(rule.weekdays)].sort() };
  }
  if (rule.kind === 'monthly_date')
    return {
      kind: rule.kind,
      day: boundedInt(rule.day, 'day', { min: 1, max: 31 }),
    };
  if (rule.kind === 'monthly_weekday')
    return {
      kind: rule.kind,
      ordinal: boundedInt(rule.ordinal, 'ordinal', { min: 1, max: 5 }),
      weekday: boundedInt(rule.weekday, 'weekday', { min: 0, max: 6 }),
    };
  throw new ValidationError('Unknown recurrence kind');
}

export function nextOccurrence(rule, from, after = from) {
  if (['interval', 'after_completion'].includes(rule.kind)) {
    const elapsed = Math.max(
      0,
      Math.floor((Date.parse(after) - Date.parse(from)) / 86400000),
    );
    return addDays(from, (Math.floor(elapsed / rule.days) + 1) * rule.days);
  }
  for (
    let date = addDays(after, 1), i = 0;
    i < 370;
    i++, date = addDays(date, 1)
  ) {
    const d = new Date(`${date}T12:00:00Z`),
      day = d.getUTCDate(),
      weekday = d.getUTCDay();
    if (rule.kind === 'weekly' && rule.weekdays.includes(weekday)) return date;
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    if (rule.kind === 'monthly_date' && day === Math.min(rule.day, last))
      return date;
    if (
      rule.kind === 'monthly_weekday' &&
      weekday === rule.weekday &&
      (rule.ordinal === 5
        ? day + 7 > last
        : Math.ceil(day / 7) === rule.ordinal)
    )
      return date;
  }
  throw new ValidationError('Could not calculate next occurrence');
}

/** Called for all task transitions, including bulk edits. Legacy schedules remain untouched. */
export function syncRecurrence(db, ticketId) {
  const row = db
    .prepare(
      `SELECT s.*, t.resolved_at, t.status FROM schedules s JOIN tickets t ON t.id = s.last_ticket_id WHERE t.id = ? AND s.recurrence IS NOT NULL`,
    )
    .get(ticketId);
  if (!row || !['resolved', 'closed'].includes(row.status) || !row.resolved_at)
    return;
  const rule = JSON.parse(row.recurrence);
  const completed = civilDate(
    new Date(row.resolved_at.replace(' ', 'T') + 'Z'),
    row.time_zone,
  );
  const anchor = row.last_due || row.next_due;
  const next =
    rule.kind === 'after_completion'
      ? addDays(completed, rule.days)
      : nextOccurrence(rule, anchor, completed > anchor ? completed : anchor);
  db.prepare('UPDATE schedules SET next_due = ? WHERE id = ?').run(
    next,
    row.id,
  );
}
