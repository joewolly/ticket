import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createTicket, updateTicket, getTicket, listTickets, bulkUpdateTickets, addComment } from '../src/api/tickets.js';
import { createDevice } from '../src/api/devices.js';
import { createSchedule, runSchedules } from '../src/api/schedules.js';
import { sweepWarranties } from '../src/api/warranty.js';
import { addAttachment, getAttachment } from '../src/api/attachments.js';
import { exportEntity } from '../src/api/export.js';
import { renderCalendar } from '../src/api/calendar.js';
import { getStats } from '../src/api/stats.js';
import { renderMetrics } from '../src/api/metrics.js';
import { createNotifier } from '../src/notify.js';
import { loadConfig } from '../src/config.js';
import { runBackup } from '../src/backup.js';

function fresh(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

test('legacy callers and automated tasks enter Next, while quick capture can choose Inbox', (t) => {
  const db = fresh(t);
  assert.equal(createTicket(db, { title: 'Existing API client' }).queue, 'next');
  assert.equal(createTicket(db, { title: 'Remember this', queue: 'inbox' }).queue, 'inbox');
  createSchedule(db, { title: 'Clean filters', interval_days: 90, next_due: '2026-01-01' });
  runSchedules(db, { today: '2026-01-01' });
  createDevice(db, { name: 'NAS', warranty_expires: '2026-01-10' });
  sweepWarranties(db, { today: '2026-01-01' });
  assert.equal(listTickets(db).filter((task) => task.queue === 'next').length, 3);
});

test('queue validation rejects invalid values on create, update, and filtering', (t) => {
  const db = fresh(t);
  const task = createTicket(db, { title: 'Valid' });
  for (const queue of ['done', '', null, 1, ['inbox']]) {
    assert.throws(() => createTicket(db, { title: 'Invalid', queue }), { status: 400 });
    assert.throws(() => updateTicket(db, task.id, { queue }), { status: 400 });
    assert.throws(() => listTickets(db, { queue }), { status: 400 });
  }
  assert.equal(listTickets(db).length, 1);
});

test('queue changes preserve progress and completion, and record only actual moves', (t) => {
  const db = fresh(t);
  const task = createTicket(db, { title: 'An idea', queue: 'inbox', status: 'blocked' });
  const moved = updateTicket(db, task.id, { queue: 'someday' });
  assert.equal(moved.status, 'blocked');
  assert.equal(moved.resolved_at, null);
  updateTicket(db, task.id, { queue: 'someday' });
  const events = getTicket(db, task.id).events.filter((e) => e.kind === 'queue');
  assert.deepEqual(events.map((e) => [e.from_value, e.to_value]), [['inbox', 'someday']]);
  const done = updateTicket(db, task.id, { status: 'resolved' });
  assert.ok(done.resolved_at);
  assert.equal(listTickets(db, { queue: 'someday' }).length, 0);
  assert.equal(listTickets(db, { status: 'done' }).length, 1);
  const stillDone = updateTicket(db, task.id, { queue: 'next' });
  assert.equal(stillDone.status, 'resolved');
  assert.equal(stillDone.resolved_at, done.resolved_at);
  const reopened = updateTicket(db, task.id, { status: 'open', queue: 'next' });
  assert.equal(reopened.resolved_at, null);
  assert.equal(listTickets(db, { queue: 'next' })[0].id, task.id);
});

test('list filters include both completed statuses and deterministic inbox/completion ordering', (t) => {
  const db = fresh(t);
  const a = createTicket(db, { title: 'First', queue: 'inbox' });
  const b = createTicket(db, { title: 'Second', queue: 'inbox' });
  createTicket(db, { title: 'Next' });
  assert.deepEqual(listTickets(db, { queue: 'inbox', sort: 'oldest' }).map((x) => x.id), [a.id, b.id]);
  updateTicket(db, a.id, { status: 'closed' });
  updateTicket(db, b.id, { status: 'resolved' });
  db.prepare('UPDATE tickets SET resolved_at = ? WHERE id = ?').run('2026-01-01 00:00:00', b.id);
  db.prepare('UPDATE tickets SET resolved_at = ? WHERE id = ?').run('2026-01-02 00:00:00', a.id);
  assert.deepEqual(listTickets(db, { status: 'done', sort: 'completed' }).map((x) => x.id), [a.id, b.id]);
  assert.equal(listTickets(db).length, 1, 'legacy default still excludes completed tasks');
});

test('bulk queue moves roll back tasks and events if any target fails', (t) => {
  const db = fresh(t);
  const a = createTicket(db, { title: 'First', queue: 'inbox' });
  const b = createTicket(db, { title: 'Second', queue: 'inbox' });
  assert.throws(() => bulkUpdateTickets(db, { ids: [a.id, 9999], queue: 'next' }), { status: 404 });
  assert.equal(getTicket(db, a.id).queue, 'inbox');
  assert.equal(getTicket(db, a.id).events.length, 1);
  assert.equal(bulkUpdateTickets(db, { ids: [a.id, b.id], queue: 'someday' }).updated, 2);
  assert.equal(listTickets(db, { queue: 'someday' }).length, 2);
});

test('search and exports retain records across all queues and completion', (t) => {
  const db = fresh(t);
  for (const queue of ['inbox', 'next', 'someday']) {
    const task = createTicket(db, { title: queue, queue });
    addComment(db, task.id, { body: 'Needle in a note' });
  }
  createTicket(db, { title: 'Needle finished', status: 'closed' });
  assert.equal(listTickets(db, { status: 'all', q: 'needle' }).length, 4);
  const exported = JSON.parse(exportEntity(db, { entity: 'tickets' }).body);
  assert.deepEqual(exported.map((x) => x.queue), ['inbox', 'next', 'someday', 'next']);
  const csv = exportEntity(db, { entity: 'tickets', format: 'csv' }).body;
  assert.ok(csv.split('\r\n')[0].split(',').includes('queue'));
});

test('only Next grows stale, while deadlines in every queue remain visible and notified', async (t) => {
  const db = fresh(t);
  const due = db.prepare("SELECT date('now', '+1 day') AS day").get().day;
  for (const queue of ['inbox', 'next', 'someday']) {
    createTicket(db, { title: `Overdue ${queue}`, queue, due_date: '2000-01-01' });
    createTicket(db, { title: `Upcoming ${queue}`, queue, due_date: due });
  }
  db.exec("UPDATE tickets SET updated_at = datetime('now', '-30 days')");
  assert.equal(getStats(db).stale.length, 2);
  assert.equal(getStats(db).overdue.length, 3);
  assert.match(renderMetrics(db), /homelab_tickets_stale 2\n/);
  const calendar = renderCalendar(db);
  for (const queue of ['inbox', 'next', 'someday']) assert.match(calendar, new RegExp(`Upcoming ${queue}`));
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true };
  });
  const notifier = createNotifier(loadConfig({
    AUTH_PASSWORD: 'test-task-password', NOTIFY_URL: 'https://example.test/notify',
    NOTIFY_EVENTS: 'ticket.overdue,ticket.due_soon', NOTIFY_DIGEST: 'weekly',
  }));
  assert.equal((await notifier.sweepOverdue(db)).length, 3);
  assert.equal((await notifier.sweepDueSoon(db)).length, 3);
  await notifier.maybeSendDigest(db);
  const digest = sent.find((x) => x.event === 'digest');
  assert.equal(digest.stale, 2);
  assert.equal(digest.overdue, 3);
  assert.equal(digest.upcoming.length, 3);
});

test('migration preserves version-5 records and attachment bytes; backup restores queue state', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'task-hub-migration-'));
  let db;
  let restored;
  let primaryError;
  try {
    const path = join(scratch, 'legacy.db');
    db = openDatabase(path);
    const task = createTicket(db, { title: 'Legacy task', status: 'closed', due_date: '2026-01-01', tags: ['home'] });
    addComment(db, task.id, { body: 'Keep this history' });
    const attachment = addAttachment(db, task.id, { filename: 'receipt.txt', contentType: 'text/plain', data: Buffer.from('receipt bytes') });
    const { queue: _queue, ...before } = getTicket(db, task.id);
    // Reconstruct the immediately preceding schema, then exercise the normal
    // open/migrate path against its on-disk records (not an empty database).
    db.exec(`DROP INDEX idx_tickets_assignee;
      DROP INDEX idx_tickets_original_due_date;
      ALTER TABLE tickets DROP COLUMN assignee_id;
      ALTER TABLE tickets DROP COLUMN original_due_date;
      DROP TABLE household_members;
      ALTER TABLE schedules DROP COLUMN is_chore;
      ALTER TABLE schedules DROP COLUMN archived;
      ALTER TABLE schedules DROP COLUMN last_due;
      DROP TABLE submissions; DROP TABLE saved_views; DROP TABLE checklist_items;
      DROP INDEX idx_tickets_project;
      ALTER TABLE tickets DROP COLUMN project_id;
      ALTER TABLE tickets DROP COLUMN today_rank;
      ALTER TABLE tickets DROP COLUMN snoozed_until;
      ALTER TABLE tickets DROP COLUMN waiting_on;
      ALTER TABLE tickets DROP COLUMN follow_up_date;
      ALTER TABLE tickets DROP COLUMN follow_up_notified_at;
      ALTER TABLE schedules DROP COLUMN recurrence;
      ALTER TABLE schedules DROP COLUMN project_id;
      ALTER TABLE schedules DROP COLUMN checklist;
      ALTER TABLE schedules DROP COLUMN time_zone;
      DROP TABLE projects;
      DROP INDEX idx_tickets_queue_status;
      ALTER TABLE tickets DROP COLUMN queue;
      PRAGMA user_version = 5`);
    db.close();
    db = null;
    db = openDatabase(path);
    const { queue, ...after } = getTicket(db, task.id);
    assert.equal(queue, 'next');
    assert.deepEqual(after, before);
    updateTicket(db, task.id, { status: 'open', queue: 'someday' });
    const snapshot = await runBackup(db, { dir: join(scratch, 'backups'), keep: 14 });
    restored = openDatabase(snapshot.file);
    assert.equal(getTicket(restored, task.id).queue, 'someday');
    assert.deepEqual(Buffer.from(getAttachment(restored, attachment.id).data), Buffer.from('receipt bytes'));
    db.close();
    db = openDatabase(path);
    assert.equal(getTicket(db, task.id).queue, 'someday');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    for (const handle of [restored, db]) {
      try {
        handle?.close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (primaryError) primaryError.cleanupError = cleanupError;
      else throw cleanupError;
    }
  }
});
