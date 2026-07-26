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
