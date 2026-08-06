import { CLOSED_STATUSES, TICKET_STATUSES, oneOf } from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

export const EXPORT_ENTITIES = ['tickets', 'devices', 'schedules'];
export const EXPORT_FORMATS = ['json', 'csv'];

/**
 * Column order for the CSV form. JSON exports hand back the same rows without
 * projection, so the two stay in step by construction.
 */
const COLUMNS = {
  tickets: [
    'id', 'title', 'status', 'priority', 'device', 'tags', 'due_date',
    'created_at', 'updated_at', 'resolved_at', 'comments', 'body',
  ],
  devices: [
    'id', 'name', 'type', 'status', 'hostname', 'ip_address', 'os',
    'location', 'serial_number', 'purchase_date', 'warranty_expires', 'cost',
    'depends_on', 'open_tickets', 'created_at', 'notes',
  ],
  schedules: [
    'id', 'title', 'priority', 'device', 'tags', 'interval_days', 'lead_days',
    'next_due', 'paused', 'last_run_at', 'body',
  ],
};

const QUERIES = {
  tickets: `
    SELECT t.id, t.title, t.status, t.priority,
           d.name AS device,
           (SELECT group_concat(tg.name) FROM ticket_tags tt
              JOIN tags tg ON tg.id = tt.tag_id WHERE tt.ticket_id = t.id) AS tags,
           t.due_date, t.created_at, t.updated_at, t.resolved_at,
           (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id) AS comments,
           t.body
      FROM tickets t
      LEFT JOIN devices d ON d.id = t.device_id`,

  devices: `
    SELECT d.id, d.name, d.type, d.status, d.hostname, d.ip_address, d.os, d.location,
           d.serial_number, d.purchase_date, d.warranty_expires, d.cost,
           p.name AS depends_on,
           (SELECT COUNT(*) FROM tickets t
             WHERE t.device_id = d.id AND t.status NOT IN (${CLOSED_LIST})) AS open_tickets,
           d.created_at, d.notes
      FROM devices d
      LEFT JOIN devices p ON p.id = d.parent_id`,

  schedules: `
    SELECT s.id, s.title, s.priority,
           d.name AS device,
           s.tags, s.interval_days, s.lead_days, s.next_due, s.paused, s.last_run_at, s.body
      FROM schedules s
      LEFT JOIN devices d ON d.id = s.device_id`,
};

const ORDER = {
  tickets: 'ORDER BY t.id ASC',
  devices: 'ORDER BY d.id ASC',
  schedules: 'ORDER BY s.id ASC',
};

/**
 * Dumps an entity for archiving or spreadsheet work. Returns the body plus the
 * headers it needs, leaving the server to do the writing.
 */
export function exportEntity(db, query = {}) {
  const entity = oneOf(query.entity, EXPORT_ENTITIES, 'entity', 'tickets');
  const format = oneOf(query.format, EXPORT_FORMATS, 'format', 'json');

  // Tickets default to everything, including closed — an export is an archive,
  // not the working list, so silently dropping resolved history would be wrong.
  const where = entity === 'tickets' && query.status && query.status !== 'all'
    ? `WHERE t.status = ${quoteStatus(query.status)}`
    : '';

  const rows = db.prepare(`${QUERIES[entity]} ${where} ${ORDER[entity]}`).all();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `homelab-${entity}-${stamp}.json`,
      body: `${JSON.stringify(rows, null, 2)}\n`,
    };
  }

  return {
    contentType: 'text/csv; charset=utf-8',
    filename: `homelab-${entity}-${stamp}.csv`,
    body: toCsv(COLUMNS[entity], rows),
  };
}

/**
 * Inlines a status into the SQL. Safe only because oneOf() has already pinned
 * the value to the enum — it can never be a fragment of the caller's choosing.
 */
function quoteStatus(status) {
  return `'${oneOf(status, TICKET_STATUSES, 'status')}'`;
}

function toCsv(columns, rows) {
  const lines = [columns.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(row[column])).join(','));
  }
  // CRLF is what RFC 4180 asks for and what Excel is happiest opening.
  return `${lines.join('\r\n')}\r\n`;
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // A cell starting with a formula character is executed on open by Excel and
  // Sheets. Prefixing with an apostrophe keeps it inert and visible as text.
  // '-' is deliberately not in this set: it leads far more legitimate values
  // ("-12 dB", "-- ran fsck") than it does attacks.
  if (/^[=+@\t\r]/.test(text)) text = `'${text}`;

  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
