import { transaction } from '../db.js';
import { recordEvent, recordChanges, listEvents } from './events.js';
import {
  CLOSED_STATUSES,
  PRIORITIES,
  TICKET_STATUSES,
  NotFoundError,
  ValidationError,
  bodyText,
  httpUrl,
  oneOf,
  optionalDate,
  optionalId,
  optionalText,
  requiredId,
  requiredText,
  tagList,
} from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

// Ranks priority so "most urgent first" sorts correctly instead of alphabetically.
const PRIORITY_RANK = `CASE t.priority
    WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const SELECT_TICKET = `
  SELECT t.*,
         d.name AS device_name,
         d.type AS device_type,
         (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count,
         (SELECT group_concat(tg.name) FROM ticket_tags tt
            JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.ticket_id = t.id) AS tag_csv
    FROM tickets t
    LEFT JOIN devices d ON d.id = t.device_id
`;

const SORTS = {
  priority: `${PRIORITY_RANK}, t.created_at DESC`,
  newest: 't.created_at DESC',
  oldest: 't.created_at ASC',
  updated: 't.updated_at DESC',
  due: 't.due_date IS NULL, t.due_date ASC',
};

export function listTickets(db, query = {}) {
  const where = [];
  const params = {};

  // `status=active` is the default view: everything still needing attention.
  if (query.status === 'active' || (!query.status && query.status !== '')) {
    where.push(`t.status NOT IN (${CLOSED_LIST})`);
  } else if (query.status && query.status !== 'all') {
    where.push('t.status = :status');
    params.status = oneOf(query.status, TICKET_STATUSES, 'status');
  }

  if (query.priority) {
    where.push('t.priority = :priority');
    params.priority = oneOf(query.priority, PRIORITIES, 'priority');
  }
  if (query.device_id) {
    where.push('t.device_id = :device_id');
    params.device_id = optionalId(query.device_id, 'device_id');
  }
  if (query.tag) {
    where.push(`t.id IN (SELECT tt.ticket_id FROM ticket_tags tt
                           JOIN tags tg ON tg.id = tt.tag_id WHERE tg.name = :tag)`);
    params.tag = String(query.tag).trim().toLowerCase();
  }
  if (query.q) {
    // Full-text search covers the title, the body, and every comment, so
    // "which ticket mentioned that PSU error?" is answerable. A query that
    // reduces to no searchable words (all punctuation) falls back to a literal
    // substring match rather than returning nothing.
    const fts = toFtsQuery(query.q);
    if (fts) {
      where.push('t.id IN (SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH :q)');
      params.q = fts;
    } else {
      where.push('(t.title LIKE :q OR t.body LIKE :q)');
      params.q = `%${query.q}%`;
    }
  }

  const order = SORTS[query.sort] ?? SORTS.priority;
  const sql = `${SELECT_TICKET}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}`;

  return db.prepare(sql).all(params).map(shapeTicket);
}

/** Returns the ticket plus its comment thread and links, oldest first. */
export function getTicket(db, id) {
  const row = db.prepare(`${SELECT_TICKET} WHERE t.id = ?`).get(id);
  if (!row) throw new NotFoundError(`No ticket with id ${id}`);

  const comments = db
    .prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC')
    .all(id);

  const links = db
    .prepare('SELECT * FROM ticket_links WHERE ticket_id = ? ORDER BY created_at ASC, id ASC')
    .all(id);

  const attachments = db
    .prepare(
      `SELECT id, filename, content_type, size, created_at FROM attachments
        WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(id);

  return { ...shapeTicket(row), comments, links, attachments, events: listEvents(db, id) };
}

/**
 * Creates a ticket. `scheduleId` is a caller-side concern rather than an input
 * field, so an API client cannot claim a ticket came from a schedule.
 */
export function createTicket(db, input = {}, { scheduleId = null } = {}) {
  const fields = parseTicket(input, { partial: false });
  const tags = tagList(input.tags) ?? [];

  if (fields.device_id !== null) assertDeviceExists(db, fields.device_id);
  fields.resolved_at = CLOSED_STATUSES.includes(fields.status) ? isoNow() : null;
  fields.schedule_id = scheduleId;

  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tickets
           (title, body, status, priority, device_id, due_date, resolved_at, schedule_id)
         VALUES
           (:title, :body, :status, :priority, :device_id, :due_date, :resolved_at, :schedule_id)`,
      )
      .run(fields);

    const id = Number(lastInsertRowid);
    setTags(db, id, tags);
    recordEvent(db, id, 'created');
    return getTicket(db, id);
  });
}

export function updateTicket(db, id, input = {}) {
  const existing = getTicket(db, id);

  const fields = parseTicket(input, { partial: true });
  const tags = tagList(input.tags);

  if (Object.keys(fields).length === 0 && tags === null) {
    throw new ValidationError('No updatable fields provided');
  }
  if (fields.device_id) assertDeviceExists(db, fields.device_id);

  // Moving the due date re-arms both date alarms: a ticket deferred to next
  // month should be nudged again as it nears, and announced again if it lapses.
  if (Object.hasOwn(fields, 'due_date') && fields.due_date !== existing.due_date) {
    fields.overdue_notified_at = null;
    fields.due_soon_notified_at = null;
  }

  // Stamp resolved_at on the transition into a closed status, and clear it on
  // the way back out, so "when was this fixed?" stays answerable after reopens.
  if (fields.status && fields.status !== existing.status) {
    const wasClosed = CLOSED_STATUSES.includes(existing.status);
    const isClosed = CLOSED_STATUSES.includes(fields.status);
    if (isClosed && !wasClosed) fields.resolved_at = isoNow();
    if (!isClosed && wasClosed) fields.resolved_at = null;
  }

  // Resolve the incoming device_id to a name now, so the event log stores what
  // the device was called at the time rather than a bare id.
  const afterDeviceName = Object.hasOwn(fields, 'device_id')
    ? deviceName(db, fields.device_id)
    : existing.device_name;

  return transaction(db, () => {
    const keys = Object.keys(fields);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = :${key}`).join(', ');
      db.prepare(
        `UPDATE tickets SET ${assignments}, updated_at = datetime('now') WHERE id = :id`,
      ).run({ ...fields, id });
    }

    recordChanges(db, id, existing, fields, {
      deviceNames: { before: existing.device_name, after: afterDeviceName },
    });

    if (tags !== null) {
      const before = existing.tags.join(', ');
      const after = [...tags].sort().join(', ');
      if (before !== after) recordEvent(db, id, 'tags', before || null, after || null);
      setTags(db, id, tags);
      db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(id);
    }
    return getTicket(db, id);
  });
}

export function deleteTicket(db, id) {
  getTicket(db, id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
}

/** Guards a bulk operation against a runaway request. */
const MAX_BULK = 500;

/**
 * Applies the same change to many tickets at once — the "select the twelve I
 * fixed this afternoon and close them all" move. The whole batch runs in one
 * transaction, so either every ticket moves or none does, and each ticket still
 * goes through updateTicket, so its event log and resolved_at bookkeeping are
 * exactly what a one-at-a-time edit would have produced.
 */
export function bulkUpdateTickets(db, input = {}) {
  const ids = input.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('ids must be a non-empty array');
  }

  // Validate every id, then collapse duplicates so a repeated id is neither
  // updated nor counted twice, and the batch limit reflects the real work.
  const clean = [...new Set(ids.map((id) => requiredId(id, 'id')))];
  if (clean.length > MAX_BULK) {
    throw new ValidationError(`Cannot update more than ${MAX_BULK} tickets at once`);
  }

  const { ids: _ids, add_tags, ...patch } = input;
  // add_tags merges onto each ticket's existing tags rather than replacing them,
  // so one label can be pinned across a selection without flattening the rest —
  // and it all rides the single transaction, so the batch stays atomic.
  const addTags = add_tags === undefined ? null : tagList(add_tags, 'add_tags');

  return transaction(db, () => {
    const updated = clean.map((id) => {
      if (addTags && addTags.length > 0) {
        const current = getTicket(db, id).tags;
        return updateTicket(db, id, { ...patch, tags: [...new Set([...current, ...addTags])] });
      }
      return updateTicket(db, id, patch);
    });
    return { updated: updated.length, tickets: updated };
  });
}

export function addComment(db, ticketId, input = {}) {
  getTicket(db, ticketId);
  const body = requiredText(input.body, 'body', 20000);

  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO comments (ticket_id, body) VALUES (?, ?)')
      .run(ticketId, body);
    // A new comment counts as activity on the ticket.
    db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticketId);
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(lastInsertRowid));
  });
}

export function deleteComment(db, ticketId, commentId) {
  const comment = db
    .prepare('SELECT * FROM comments WHERE id = ? AND ticket_id = ?')
    .get(commentId, ticketId);
  if (!comment) throw new NotFoundError(`No comment with id ${commentId} on ticket ${ticketId}`);
  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
}

/** Attaches a reference URL to a ticket. */
export function addLink(db, ticketId, input = {}) {
  getTicket(db, ticketId);
  const url = httpUrl(input.url, 'url');
  const label = optionalText(input.label, 'label', 200);

  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO ticket_links (ticket_id, url, label) VALUES (?, ?, ?)')
      .run(ticketId, url, label);
    db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticketId);
    return db.prepare('SELECT * FROM ticket_links WHERE id = ?').get(Number(lastInsertRowid));
  });
}

export function deleteLink(db, ticketId, linkId) {
  const link = db
    .prepare('SELECT 1 FROM ticket_links WHERE id = ? AND ticket_id = ?')
    .get(linkId, ticketId);
  if (!link) throw new NotFoundError(`No link with id ${linkId} on ticket ${ticketId}`);
  db.prepare('DELETE FROM ticket_links WHERE id = ?').run(linkId);
}

/** All tags in use, with how many tickets carry each. */
export function listTags(db) {
  return db
    .prepare(
      `SELECT tg.name, COUNT(tt.ticket_id) AS ticket_count
         FROM tags tg
         LEFT JOIN ticket_tags tt ON tt.tag_id = tg.id
        GROUP BY tg.id
        HAVING ticket_count > 0
        ORDER BY ticket_count DESC, tg.name ASC`,
    )
    .all();
}

function parseTicket(input, { partial }) {
  const fields = {};
  const has = (key) => Object.hasOwn(input, key);

  if (!partial || has('title')) fields.title = requiredText(input.title, 'title', 200);
  if (!partial || has('body')) fields.body = bodyText(input.body, 'body');
  if (!partial || has('status')) fields.status = oneOf(input.status, TICKET_STATUSES, 'status', 'open');
  if (!partial || has('priority')) {
    fields.priority = oneOf(input.priority, PRIORITIES, 'priority', 'medium');
  }
  if (!partial || has('device_id')) fields.device_id = optionalId(input.device_id, 'device_id');
  if (!partial || has('due_date')) fields.due_date = optionalDate(input.due_date, 'due_date');

  return fields;
}

/** Replaces a ticket's tags wholesale, creating any tag rows that are new. */
function setTags(db, ticketId, tags) {
  db.prepare('DELETE FROM ticket_tags WHERE ticket_id = ?').run(ticketId);

  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare('INSERT INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)');

  for (const tag of tags) {
    insertTag.run(tag);
    link.run(ticketId, findTag.get(tag).id);
  }
}

function assertDeviceExists(db, deviceId) {
  const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId);
  if (!exists) throw new ValidationError(`No device with id ${deviceId}`);
}

/** The name of a device by id, or null — used to snapshot events readably. */
function deviceName(db, deviceId) {
  if (!deviceId) return null;
  return db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId)?.name ?? null;
}

/** Turns the group_concat CSV into a real array for the client. */
function shapeTicket({ tag_csv, ...ticket }) {
  return {
    ...ticket,
    tags: tag_csv ? tag_csv.split(',').sort() : [],
    is_open: !CLOSED_STATUSES.includes(ticket.status),
  };
}

function isoNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Turns free user text into a safe FTS5 MATCH expression. Each run of letters,
 * digits, or underscores becomes a quoted prefix term ("disk"*), which means a
 * partial word still matches and — crucially — the user's raw input never
 * reaches the FTS5 parser, where a stray quote or operator would otherwise be a
 * syntax error rather than a search. Returns '' when nothing searchable remains.
 */
function toFtsQuery(text) {
  const terms = String(text).match(/[\p{L}\p{N}_]+/gu);
  if (!terms) return '';
  return terms.map((term) => `"${term}"*`).join(' ');
}
