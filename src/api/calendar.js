import { CLOSED_STATUSES } from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * An iCalendar feed of everything with a date attached: open tickets that have
 * a due date, and the next occurrence of each active schedule. A calendar app
 * subscribes to it once and the homelab's deadlines show up next to the rest of
 * life, which is a good deal more likely to get looked at than a dashboard.
 *
 * All-day VEVENTs, because a due date is a day and not a time. The feed is
 * read-only and regenerated on every request, so there is nothing to keep in
 * step — the calendar re-fetches on its own schedule.
 */
export function renderCalendar(db, { now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//homelab-tickets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Homelab',
  ];

  const stamp = icsTimestamp(now);

  const tickets = db
    .prepare(
      `SELECT id, title, priority, due_date FROM tickets
        WHERE status NOT IN (${CLOSED_LIST}) AND due_date IS NOT NULL
        ORDER BY due_date ASC`,
    )
    .all();

  for (const ticket of tickets) {
    lines.push(
      ...event({
        uid: `ticket-${ticket.id}@homelab`,
        stamp,
        date: ticket.due_date,
        summary: `[${ticket.priority}] ${ticket.title}`,
        description: `Homelab ticket #${ticket.id}`,
      }),
    );
  }

  const schedules = db
    .prepare(
      `SELECT id, title, next_due FROM schedules
        WHERE paused = 0 AND (recurrence IS NULL OR last_ticket_id IS NULL OR NOT EXISTS
          (SELECT 1 FROM tickets WHERE id = schedules.last_ticket_id AND status NOT IN (${CLOSED_LIST})))
        ORDER BY next_due ASC`,
    )
    .all();

  for (const schedule of schedules) {
    lines.push(
      ...event({
        uid: `schedule-${schedule.id}@homelab`,
        stamp,
        date: schedule.next_due,
        summary: `\u{1F527} ${schedule.title}`,
        description: `Recurring maintenance (schedule #${schedule.id})`,
      }),
    );
  }

  for (const task of db.prepare(`SELECT id,title,waiting_on,follow_up_date FROM tickets WHERE status NOT IN (${CLOSED_LIST}) AND waiting_on IS NOT NULL AND follow_up_date IS NOT NULL AND (snoozed_until IS NULL OR snoozed_until <= app_today())`).all()) {
    lines.push(...event({ uid: `followup-${task.id}@homelab`, stamp, date: task.follow_up_date, summary: `Follow up: ${task.title}`, description: task.waiting_on }));
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 wants CRLF line breaks; a trailing one keeps strict parsers happy.
  return lines.map(fold).join('\r\n') + '\r\n';
}

function event({ uid, stamp, date, summary, description }) {
  const day = date.replaceAll('-', '');
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    // A DATE value with no time is what makes it an all-day entry; DTEND is the
    // exclusive next day, which is how iCalendar spells a single full day.
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    'END:VEVENT',
  ];
}

/** Escapes the four characters iCalendar treats as special in a text value. */
function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Folds a content line to the 75-octet limit RFC 5545 sets, continuing with a
 * leading space. Measured in bytes, not characters, so a multi-byte glyph is
 * never split down the middle.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    // First line takes 75 octets; continuations take 74, the leading space
    // making up the difference.
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    // Do not split a UTF-8 sequence: back up off any continuation byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

/** 'YYYY-MM-DD' as the exclusive end date 'YYYYMMDD' one day later. */
function nextDay(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10).replaceAll('-', '');
}

/** UTC timestamp in the basic format DTSTAMP requires. */
function icsTimestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
