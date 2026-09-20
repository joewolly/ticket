import { transaction } from '../db.js';
import { civilDate, addDays, dateFor } from '../dates.js';
import { recordEvent } from './events.js';
import { listTickets, getTicket, updateTicket } from './tickets.js';
import {
  requiredText,
  requiredId,
  optionalDate,
  optionalId,
  optionalText,
  bodyText,
  boolean,
  ValidationError,
  NotFoundError,
} from '../validate.js';

export function planningFields(input, partial = true) {
  const fields = {};
  for (const key of ['snoozed_until', 'follow_up_date']) {
    if (!partial || Object.hasOwn(input, key))
      fields[key] = optionalDate(input[key], key);
  }
  if (!partial || Object.hasOwn(input, 'project_id'))
    fields.project_id = optionalId(input.project_id, 'project_id');
  if (!partial || Object.hasOwn(input, 'waiting_on'))
    fields.waiting_on = optionalText(input.waiting_on, 'waiting_on', 500);
  return fields;
}

export function normalizePlanning(db, fields, input, existing = {}) {
  if (
    fields.project_id &&
    !db.prepare('SELECT id FROM projects WHERE id = ?').get(fields.project_id)
  )
    throw new ValidationError('Project does not exist');
  const merged = { ...existing, ...fields };
  if (Object.hasOwn(input, 'today')) {
    if (boolean(input.today, 'today')) {
      if (['resolved', 'closed'].includes(merged.status))
        throw new ValidationError('Reopen the task before adding it to Today');
      fields.queue = 'next';
      fields.snoozed_until = null;
      fields.waiting_on = null;
      fields.follow_up_date = null;
      fields.today_rank =
        existing.today_rank ??
        db
          .prepare(
            'SELECT coalesce(max(today_rank), -1) + 1 AS rank FROM tickets',
          )
          .get().rank;
    } else fields.today_rank = null;
  }
  const final = { ...merged, ...fields };
  if (
    ['resolved', 'closed'].includes(final.status) ||
    final.queue !== 'next' ||
    final.waiting_on ||
    final.snoozed_until > dateFor(db)
  )
    fields.today_rank = null;
  if (!final.waiting_on) fields.follow_up_date = null;
  if (
    (fields.follow_up_date !== undefined &&
      fields.follow_up_date !== existing.follow_up_date) ||
    (fields.waiting_on !== undefined &&
      fields.waiting_on !== existing.waiting_on)
  )
    fields.follow_up_notified_at = null;
}

export function planningFilter(query, where, params, today = civilDate()) {
  for (const key of ['today', 'waiting', 'snoozed', 'actionable']) {
    if (query[key] !== undefined)
      query = { ...query, [key]: boolean(query[key], key) };
  }
  const dateParam = () => {
    params.planning_today = today;
    return ':planning_today';
  };
  if (query.project_id) {
    where.push('t.project_id = :project_id');
    params.project_id = requiredId(query.project_id, 'project_id');
  }
  if (query.today === 'true' || query.today === true)
    where.push('t.today_rank IS NOT NULL');
  if (query.waiting === 'true' || query.waiting === true)
    where.push('t.waiting_on IS NOT NULL');
  if (query.snoozed === 'true' || query.snoozed === true)
    where.push(`t.snoozed_until > ${dateParam()}`);
  if (query.actionable === 'true' || query.actionable === true) {
    where.push(
      `(t.snoozed_until IS NULL OR t.snoozed_until <= ${dateParam()})`,
    );
    where.push(`(t.waiting_on IS NULL OR t.follow_up_date <= ${dateParam()})`);
  }
  if (query.due) {
    if (query.due !== 'none') dateParam();
    if (query.due === 'overdue') where.push('t.due_date < :planning_today');
    else if (query.due === 'today') where.push('t.due_date = :planning_today');
    else if (query.due === 'week') {
      where.push('t.due_date BETWEEN :planning_today AND :planning_week');
      params.planning_week = addDays(today, 7);
    } else if (query.due === 'none') where.push('t.due_date IS NULL');
    else throw new ValidationError('Invalid due filter');
  }
}

export function orderToday(db, input) {
  return transaction(db, () => {
    const current = listTickets(db, {
      today: 'true',
      status: 'active',
      sort: 'today',
    }).map((t) => t.id);
    const ids = exactOrder(input.ids, current);
    ids.forEach((id, rank) =>
      db
        .prepare('UPDATE tickets SET today_rank = ? WHERE id = ?')
        .run(rank, id),
    );
    return listTickets(db, { today: 'true', sort: 'today' });
  });
}

export function exactOrder(ids, current) {
  if (
    !Array.isArray(ids) ||
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !current.includes(id))
  )
    throw new ValidationError(
      'Order must contain every current item exactly once; refresh and retry',
    );
  return ids;
}

export function checklist(db, ticketId, itemId, input, method = 'GET') {
  getTicket(db, ticketId);
  const list = () =>
    db
      .prepare(
        'SELECT * FROM checklist_items WHERE ticket_id = ? ORDER BY position, id',
      )
      .all(ticketId);
  if (method === 'GET') return list();
  return transaction(db, () => {
    if (method === 'PUT') {
      exactOrder(
        input.ids,
        list().map((i) => i.id),
      ).forEach((id, rank) =>
        db
          .prepare('UPDATE checklist_items SET position = ? WHERE id = ?')
          .run(rank, id),
      );
    } else if (method === 'POST') {
      db.prepare(
        'INSERT INTO checklist_items(ticket_id, title, position) VALUES (?, ?, ?)',
      ).run(ticketId, requiredText(input.title, 'title', 500), list().length);
    } else {
      const item = list().find((i) => i.id === Number(itemId));
      if (!item) throw new NotFoundError('Checklist item not found');
      if (method === 'DELETE')
        db.prepare('DELETE FROM checklist_items WHERE id = ?').run(item.id);
      else
        db.prepare(
          'UPDATE checklist_items SET title = ?, completed = ? WHERE id = ?',
        ).run(
          input.title === undefined
            ? item.title
            : requiredText(input.title, 'title', 500),
          input.completed === undefined
            ? item.completed
            : Number(boolean(input.completed, 'completed')),
          item.id,
        );
    }
    recordEvent(
      db,
      ticketId,
      'checklist',
      null,
      method === 'PUT'
        ? 'Reordered checklist'
        : method === 'DELETE'
          ? 'Removed checklist item'
          : input.title || 'Updated checklist item',
    );
    db.prepare(
      "UPDATE tickets SET updated_at = datetime('now') WHERE id = ?",
    ).run(ticketId);
    return list();
  });
}

export function projects(db, id, input = {}, method = 'GET') {
  const row = id
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    : null;
  if (id && !row) throw new NotFoundError('Project not found');
  if (method === 'DELETE')
    return transaction(db, () => {
      for (const t of listTickets(db, { project_id: id, status: 'all' }))
        updateTicket(db, t.id, { project_id: null });
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
  if (method === 'POST' || method === 'PATCH') {
    const name = requiredText(input.name ?? row?.name, 'name', 200);
    const notes = bodyText(input.notes ?? row?.notes, 'notes');
    const archived = Number(
      boolean(input.archived ?? row?.archived, 'archived'),
    );
    if (id)
      db.prepare(
        'UPDATE projects SET name = ?, notes = ?, archived = ? WHERE id = ?',
      ).run(name, notes, archived, id);
    else
      id = Number(
        db
          .prepare(
            'INSERT INTO projects(name, notes, archived) VALUES (?, ?, ?)',
          )
          .run(name, notes, archived).lastInsertRowid,
      );
  }
  const enrich = (p) => {
    const tasks = listTickets(db, { project_id: p.id, status: 'all' });
    const actionable = listTickets(db, {
      project_id: p.id,
      queue: 'next',
      actionable: 'true',
    }).find((t) => !t.waiting_on);
    return {
      ...p,
      total: tasks.length,
      completed: tasks.filter((t) => !t.is_open).length,
      next_action: actionable ?? null,
    };
  };
  if (id)
    return {
      ...enrich(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)),
      tickets: listTickets(db, { project_id: id, status: 'all' }),
    };
  return db
    .prepare(
      'SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE, id',
    )
    .all()
    .map(enrich);
}

const FILTERS = new Set([
  'status',
  'queue',
  'priority',
  'tag',
  'q',
  'sort',
  'device_id',
  'project_id',
  'today',
  'waiting',
  'snoozed',
  'actionable',
  'due',
]);
export function savedViews(db, id, input = {}, method = 'GET') {
  const list = () =>
    db
      .prepare('SELECT * FROM saved_views ORDER BY position, id')
      .all()
      .map((r) => ({ ...r, filters: JSON.parse(r.filters) }));
  const row = id ? list().find((r) => r.id === Number(id)) : null;
  if (id && !row) throw new NotFoundError('Saved view not found');
  if (method === 'DELETE') {
    db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
    return;
  }
  if (method === 'PUT')
    return transaction(db, () => {
      exactOrder(
        input.ids,
        list().map((r) => r.id),
      ).forEach((item, pos) =>
        db
          .prepare('UPDATE saved_views SET position = ? WHERE id = ?')
          .run(pos, item),
      );
      return list();
    });
  if (method === 'POST' || method === 'PATCH') {
    const name = requiredText(input.name ?? row?.name, 'name', 100);
    const filters = input.filters ?? row?.filters ?? {};
    if (
      typeof filters !== 'object' ||
      filters === null ||
      Array.isArray(filters) ||
      Object.keys(filters).some((key) => !FILTERS.has(key)) ||
      Object.values(filters).some(
        (v) => !['string', 'number', 'boolean'].includes(typeof v),
      )
    )
      throw new ValidationError('Invalid saved filters');
    if (JSON.stringify(filters).length > 4000)
      throw new ValidationError('Saved filters too long');
    listTickets(db, filters); // Same validation and query interpretation as the live list.
    if (id)
      db.prepare(
        'UPDATE saved_views SET name = ?, filters = ? WHERE id = ?',
      ).run(name, JSON.stringify(filters), id);
    else
      id = Number(
        db
          .prepare(
            'INSERT INTO saved_views(name, filters, position) VALUES (?, ?, ?)',
          )
          .run(name, JSON.stringify(filters), list().length).lastInsertRowid,
      );
  }
  return id ? list().find((r) => r.id === Number(id)) : list();
}
