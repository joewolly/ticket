import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createDevice } from '../src/api/devices.js';
import {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  addComment,
  deleteComment,
  listTags,
  bulkUpdateTickets,
} from '../src/api/tickets.js';
import { getStats } from '../src/api/stats.js';

const fresh = () => openDatabase(':memory:');

test('creates a ticket with defaults and no tags', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'UPS beeping' });

  assert.equal(ticket.status, 'open');
  assert.equal(ticket.priority, 'medium');
  assert.equal(ticket.body, '');
  assert.equal(ticket.device_id, null);
  assert.equal(ticket.resolved_at, null);
  assert.equal(ticket.is_open, true);
  assert.deepEqual(ticket.tags, []);
});

test('requires a title and rejects unknown enum values', () => {
  const db = fresh();
  assert.throws(() => createTicket(db, {}), { status: 400 });
  assert.throws(() => createTicket(db, { title: 'x', status: 'wat' }), { status: 400 });
  assert.throws(() => createTicket(db, { title: 'x', priority: 'urgent' }), { status: 400 });
  assert.throws(() => createTicket(db, { title: 'x', due_date: '11/03/2026' }), { status: 400 });
});

test('rejects a ticket pointed at a device that does not exist', () => {
  const db = fresh();
  assert.throws(() => createTicket(db, { title: 'x', device_id: 42 }), {
    status: 400,
    message: /No device with id 42/,
  });
});

test('joins the device name onto the ticket', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01', type: 'nas' });
  const ticket = createTicket(db, { title: 'disk 3 failing', device_id: device.id });

  assert.equal(ticket.device_name, 'nas-01');
  assert.equal(ticket.device_type, 'nas');
});

test('stamps resolved_at on close and clears it on reopen', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'fan replacement' });
  assert.equal(ticket.resolved_at, null);

  const resolved = updateTicket(db, ticket.id, { status: 'resolved' });
  assert.ok(resolved.resolved_at, 'resolved_at should be set');
  assert.equal(resolved.is_open, false);

  const reopened = updateTicket(db, ticket.id, { status: 'open' });
  assert.equal(reopened.resolved_at, null, 'reopening should clear resolved_at');
  assert.equal(reopened.is_open, true);
});

test('keeps resolved_at stable when moving between closed statuses', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x', status: 'resolved' });
  const first = ticket.resolved_at;

  const closed = updateTicket(db, ticket.id, { status: 'closed' });
  assert.equal(closed.resolved_at, first);
});

test('a partial update leaves untouched fields alone', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'a', body: 'details', priority: 'high' });

  const updated = updateTicket(db, ticket.id, { status: 'blocked' });

  assert.equal(updated.body, 'details');
  assert.equal(updated.priority, 'high');
  assert.equal(updated.title, 'a');
});

test('rejects an update with no usable fields', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'a' });
  assert.throws(() => updateTicket(db, ticket.id, {}), { status: 400 });
});

test('normalizes, deduplicates, and replaces tags', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x', tags: ['Disk', 'disk', ' Needs Parts '] });
  assert.deepEqual(ticket.tags, ['disk', 'needs-parts']);

  const updated = updateTicket(db, ticket.id, { tags: ['backup'] });
  assert.deepEqual(updated.tags, ['backup'], 'tags are replaced wholesale, not merged');

  // The orphaned tag row stays but drops out of the in-use listing.
  assert.deepEqual(listTags(db).map((t) => t.name), ['backup']);
});

test('counts tag usage across tickets', () => {
  const db = fresh();
  createTicket(db, { title: 'a', tags: ['disk'] });
  createTicket(db, { title: 'b', tags: ['disk', 'urgent'] });

  // node:sqlite hands back null-prototype rows, so compare the data only.
  assert.deepEqual(
    listTags(db).map(({ name, ticket_count }) => ({ name, ticket_count })),
    [
      { name: 'disk', ticket_count: 2 },
      { name: 'urgent', ticket_count: 1 },
    ],
  );
});

test('defaults the list to active tickets and can widen to all', () => {
  const db = fresh();
  createTicket(db, { title: 'still broken' });
  createTicket(db, { title: 'fixed', status: 'resolved' });

  assert.deepEqual(listTickets(db).map((t) => t.title), ['still broken']);
  assert.equal(listTickets(db, { status: 'all' }).length, 2);
  assert.deepEqual(listTickets(db, { status: 'resolved' }).map((t) => t.title), ['fixed']);
});

test('filters by priority, device, tag, and text', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01' });
  createTicket(db, { title: 'smart errors', priority: 'critical', device_id: device.id, tags: ['disk'] });
  createTicket(db, { title: 'label the cables', priority: 'low' });

  assert.deepEqual(listTickets(db, { priority: 'critical' }).map((t) => t.title), ['smart errors']);
  assert.deepEqual(listTickets(db, { device_id: device.id }).map((t) => t.title), ['smart errors']);
  assert.deepEqual(listTickets(db, { tag: 'disk' }).map((t) => t.title), ['smart errors']);
  assert.deepEqual(listTickets(db, { q: 'cable' }).map((t) => t.title), ['label the cables']);
});

test('sorts by priority rank rather than alphabetically', () => {
  const db = fresh();
  createTicket(db, { title: 'low one', priority: 'low' });
  createTicket(db, { title: 'critical one', priority: 'critical' });
  createTicket(db, { title: 'medium one', priority: 'medium' });
  createTicket(db, { title: 'high one', priority: 'high' });

  assert.deepEqual(listTickets(db).map((t) => t.priority), [
    'critical', 'high', 'medium', 'low',
  ]);
});

test('adds, lists, and deletes comments', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x' });

  const comment = addComment(db, ticket.id, { body: 'swapped the cable' });
  assert.equal(comment.body, 'swapped the cable');

  const withComment = getTicket(db, ticket.id);
  assert.equal(withComment.comments.length, 1);
  assert.equal(withComment.comment_count, 1);

  deleteComment(db, ticket.id, comment.id);
  assert.equal(getTicket(db, ticket.id).comments.length, 0);
});

test('rejects an empty comment and one aimed at the wrong ticket', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x' });
  const other = createTicket(db, { title: 'y' });
  const comment = addComment(db, ticket.id, { body: 'note' });

  assert.throws(() => addComment(db, ticket.id, { body: '  ' }), { status: 400 });
  assert.throws(() => deleteComment(db, other.id, comment.id), { status: 404 });
});

test('deleting a ticket removes its comments and tag links', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x', tags: ['disk'] });
  addComment(db, ticket.id, { body: 'note' });

  deleteTicket(db, ticket.id);

  assert.throws(() => getTicket(db, ticket.id), { status: 404 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ticket_tags').get().n, 0);
});

test('a failed create leaves no partial row behind', () => {
  const db = fresh();
  assert.throws(() => createTicket(db, { title: 'x', tags: ['ok', 'x'.repeat(60)] }), {
    status: 400,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
});

test('stats summarize the current state', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01' });
  createTicket(db, { title: 'a', device_id: device.id, priority: 'critical' });
  createTicket(db, { title: 'b', device_id: device.id });
  createTicket(db, { title: 'c', status: 'resolved' });
  createTicket(db, { title: 'overdue one', due_date: '2020-01-01' });

  const stats = getStats(db);

  assert.equal(stats.total_tickets, 4);
  assert.equal(stats.open_tickets, 3);
  assert.equal(stats.total_devices, 1);
  assert.equal(stats.hot_devices[0].open_tickets, 2);
  assert.deepEqual(stats.overdue.map((t) => t.title), ['overdue one']);
  assert.deepEqual(stats.recently_resolved.map((t) => t.title), ['c']);
});

test('404s on a missing ticket', () => {
  const db = fresh();
  assert.throws(() => getTicket(db, 999), { status: 404 });
  assert.throws(() => updateTicket(db, 999, { title: 'x' }), { status: 404 });
  assert.throws(() => deleteTicket(db, 999), { status: 404 });
});

/* ---- Activity timeline --------------------------------------------------- */

test('records an event when a ticket is created', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x' });
  const { events } = getTicket(db, ticket.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'created');
});

test('logs a line for each field that actually moves', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01' });
  const ticket = createTicket(db, { title: 'x' });

  updateTicket(db, ticket.id, { status: 'blocked', priority: 'high' });
  updateTicket(db, ticket.id, { device_id: device.id });
  updateTicket(db, ticket.id, { due_date: '2030-01-01' });
  updateTicket(db, ticket.id, { tags: ['disk'] });
  // A no-op update to an unchanged value records nothing.
  updateTicket(db, ticket.id, { priority: 'high' });

  const { events } = getTicket(db, ticket.id);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'status', 'priority', 'device', 'due_date', 'tags']);

  const status = events.find((e) => e.kind === 'status');
  assert.equal(status.from_value, 'open');
  assert.equal(status.to_value, 'blocked');

  const device_evt = events.find((e) => e.kind === 'device');
  assert.equal(device_evt.to_value, 'nas-01', 'device events snapshot the name, not the id');
});

test('a rolled-back update leaves no event behind', () => {
  const db = fresh();
  const ticket = createTicket(db, { title: 'x' });
  // A tag over the length ceiling fails after the field update line would run.
  assert.throws(() => updateTicket(db, ticket.id, { status: 'blocked', tags: ['y'.repeat(60)] }), {
    status: 400,
  });
  const { events, status } = getTicket(db, ticket.id);
  assert.equal(status, 'open', 'the status change rolled back');
  assert.equal(events.length, 1, 'only the creation event remains');
});

/* ---- Full-text search ---------------------------------------------------- */

test('full-text search matches title, body, and comments', () => {
  const db = fresh();
  const a = createTicket(db, { title: 'UPS beeping', body: 'the battery reads low' });
  const b = createTicket(db, { title: 'disk failing', body: 'smart errors' });
  addComment(db, b.id, { body: 'swapped the PSU cable' });

  const titles = (q) => listTickets(db, { q, status: 'all' }).map((t) => t.title).sort();
  assert.deepEqual(titles('battery'), ['UPS beeping']);
  assert.deepEqual(titles('psu'), ['disk failing'], 'a comment is searchable');
  assert.deepEqual(titles('fail'), ['disk failing'], 'prefix matching');
  assert.deepEqual(titles('smart errors'), ['disk failing'], 'all terms must match');
  assert.deepEqual(titles('nonesuch'), []);
  // A term unique to the first ticket returns it and nothing else.
  assert.deepEqual(titles('beeping'), ['UPS beeping']);
  assert.equal(a.id > 0, true);
});

test('a search reduced to punctuation still runs as a literal match', () => {
  const db = fresh();
  createTicket(db, { title: 'C++ build broke' });
  // No word characters survive tokenizing "+++", so the LIKE fallback carries it.
  assert.deepEqual(listTickets(db, { q: '+++', status: 'all' }).map((t) => t.title), []);
  assert.equal(listTickets(db, { q: 'build', status: 'all' }).length, 1);
});

test('search follows edits to the body and comments', () => {
  const db = fresh();
  const t = createTicket(db, { title: 'router', body: 'wifi drops' });
  assert.equal(listTickets(db, { q: 'wifi', status: 'all' }).length, 1);

  updateTicket(db, t.id, { body: 'replaced the antenna' });
  assert.equal(listTickets(db, { q: 'wifi', status: 'all' }).length, 0, 'stale term gone');
  assert.equal(listTickets(db, { q: 'antenna', status: 'all' }).length, 1);

  const c = addComment(db, t.id, { body: 'firmware upgraded' });
  assert.equal(listTickets(db, { q: 'firmware', status: 'all' }).length, 1);
  deleteComment(db, t.id, c.id);
  assert.equal(listTickets(db, { q: 'firmware', status: 'all' }).length, 0);
});

/* ---- Bulk updates -------------------------------------------------------- */

test('applies one change across many tickets in a single transaction', () => {
  const db = fresh();
  const a = createTicket(db, { title: 'a' });
  const b = createTicket(db, { title: 'b' });

  const result = bulkUpdateTickets(db, { ids: [a.id, b.id], status: 'closed' });
  assert.equal(result.updated, 2);
  assert.ok(result.tickets.every((t) => t.status === 'closed'));
  // Each ticket still records the transition, exactly as a single edit would.
  assert.ok(getTicket(db, a.id).events.some((e) => e.kind === 'status'));
});

test('a bulk update rejects an empty or oversized id list', () => {
  const db = fresh();
  assert.throws(() => bulkUpdateTickets(db, { ids: [], status: 'closed' }), { status: 400 });
  assert.throws(() => bulkUpdateTickets(db, {}), { status: 400 });
  // 501 distinct ids exceeds the 500 batch ceiling.
  const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
  assert.throws(() => bulkUpdateTickets(db, { ids: tooMany, status: 'closed' }), {
    status: 400,
    message: /more than 500/,
  });
});

test('a bulk update collapses duplicate ids', () => {
  const db = fresh();
  const a = createTicket(db, { title: 'a' });
  const result = bulkUpdateTickets(db, { ids: [a.id, a.id, a.id], status: 'closed' });
  assert.equal(result.updated, 1, 'the same ticket is not counted three times');
});

test('bulk add_tags merges onto each ticket rather than replacing', () => {
  const db = fresh();
  const a = createTicket(db, { title: 'a', tags: ['disk'] });
  const b = createTicket(db, { title: 'b', tags: ['network'] });

  bulkUpdateTickets(db, { ids: [a.id, b.id], add_tags: ['urgent'] });
  assert.deepEqual(getTicket(db, a.id).tags, ['disk', 'urgent']);
  assert.deepEqual(getTicket(db, b.id).tags, ['network', 'urgent']);
});

test('a bulk update is all-or-nothing', () => {
  const db = fresh();
  const a = createTicket(db, { title: 'a' });
  // Second id does not exist, so the whole batch must roll back.
  assert.throws(() => bulkUpdateTickets(db, { ids: [a.id, 9999], status: 'closed' }), {
    status: 404,
  });
  assert.equal(getTicket(db, a.id).status, 'open', 'the first ticket was not left changed');
});
