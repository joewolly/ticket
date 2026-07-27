import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, transaction } from '../src/db.js';
import { createDevice } from '../src/api/devices.js';
import { getTicket, listTickets } from '../src/api/tickets.js';
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedules,
} from '../src/api/schedules.js';

let db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

/** Shifts a schedule's stored due date without going through validation. */
const setDue = (id, date) =>
  db.prepare('UPDATE schedules SET next_due = ? WHERE id = ?').run(date, id);

const today = () => db.prepare(`SELECT date('now') AS d`).get().d;
const daysFromNow = (n) =>
  db.prepare(`SELECT date('now', ?) AS d`).get(`${n >= 0 ? '+' : ''}${n} days`).d;

/* ---- Creating ----------------------------------------------------------- */

test('a new schedule defaults to being due today', () => {
  const schedule = createSchedule(db, { title: 'Check disks', interval_days: 30 });

  assert.equal(schedule.next_due, today());
  assert.equal(schedule.paused, false);
  assert.equal(schedule.lead_days, 0);
  assert.deepEqual(schedule.tags, []);
});

test('normalizes tags the same way tickets do', () => {
  const schedule = createSchedule(db, {
    title: 'Rotate keys',
    interval_days: 90,
    tags: ['Needs Parts', 'needs-parts', 'SECURITY'],
  });

  assert.deepEqual(schedule.tags.sort(), ['needs-parts', 'security']);
});

test('rejects an interval outside the supported range', () => {
  assert.throws(() => createSchedule(db, { title: 'x', interval_days: 0 }), /between 1 and 3650/);
  assert.throws(() => createSchedule(db, { title: 'x', interval_days: 5000 }), /between 1 and 3650/);
});

test('rejects a lead time that would make the schedule perpetually due', () => {
  assert.throws(
    () => createSchedule(db, { title: 'x', interval_days: 7, lead_days: 7 }),
    /lead_days must be smaller/,
  );
});

test('rejects a lead time raised past the interval by a later patch', () => {
  const schedule = createSchedule(db, { title: 'x', interval_days: 10, lead_days: 1 });

  assert.throws(
    () => updateSchedule(db, schedule.id, { lead_days: 10 }),
    /lead_days must be smaller/,
  );
  // The stored interval is still consulted when only lead_days is sent.
  assert.equal(getSchedule(db, schedule.id).lead_days, 1);
});

test('rejects a device that does not exist', () => {
  assert.throws(
    () => createSchedule(db, { title: 'x', interval_days: 30, device_id: 999 }),
    /No device with id 999/,
  );
});

/* ---- Firing ------------------------------------------------------------- */

test('fires a due schedule and advances it by one interval', () => {
  const schedule = createSchedule(db, { title: 'Replace filters', interval_days: 30 });

  const fired = runSchedules(db);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].schedule_id, schedule.id);

  const ticket = getTicket(db, fired[0].ticket.id);
  assert.equal(ticket.title, 'Replace filters');
  assert.equal(ticket.due_date, today());
  assert.equal(ticket.schedule_id, schedule.id);

  const after = getSchedule(db, schedule.id);
  assert.equal(after.next_due, daysFromNow(30));
  assert.equal(after.last_ticket_id, ticket.id);
  assert.ok(after.last_run_at);
});

test('copies the template onto the generated ticket', () => {
  const device = createDevice(db, { name: 'nas-01', type: 'nas' });
  createSchedule(db, {
    title: 'Scrub the pool',
    body: 'zpool scrub tank',
    priority: 'high',
    device_id: device.id,
    interval_days: 30,
    tags: ['storage', 'maintenance'],
  });

  const [{ ticket }] = runSchedules(db);

  assert.equal(ticket.body, 'zpool scrub tank');
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.device_name, 'nas-01');
  assert.deepEqual(ticket.tags, ['maintenance', 'storage']);
});

test('does not fire twice for the same occurrence', () => {
  createSchedule(db, { title: 'Weekly check', interval_days: 7 });

  assert.equal(runSchedules(db).length, 1);
  assert.equal(runSchedules(db).length, 0);
  assert.equal(listTickets(db).length, 1);
});

test('fires early by the lead time', () => {
  const schedule = createSchedule(db, { title: 'Renew certs', interval_days: 90, lead_days: 14 });
  setDue(schedule.id, daysFromNow(10));

  const fired = runSchedules(db);
  assert.equal(fired.length, 1);
  // The ticket carries the real due date, not the day it was opened.
  assert.equal(fired[0].ticket.due_date, daysFromNow(10));
});

test('does not fire before the lead window opens', () => {
  const schedule = createSchedule(db, { title: 'Renew certs', interval_days: 90, lead_days: 7 });
  setDue(schedule.id, daysFromNow(30));

  assert.equal(runSchedules(db).length, 0);
});

test('a schedule that fell behind generates one ticket, not one per interval', () => {
  const schedule = createSchedule(db, { title: 'Monthly reboot', interval_days: 30 });
  // As if the machine had been off for most of a year.
  setDue(schedule.id, daysFromNow(-300));

  const fired = runSchedules(db);
  assert.equal(fired.length, 1, 'one catch-up ticket');
  // It keeps the date it was genuinely due, so the backlog is not hidden.
  assert.equal(fired[0].ticket.due_date, daysFromNow(-300));

  // And the next occurrence is in the future rather than still in the past.
  const after = getSchedule(db, schedule.id);
  assert.ok(after.next_due > today(), `${after.next_due} should be after ${today()}`);
  assert.equal(runSchedules(db).length, 0, 'no second catch-up on the next sweep');
});

test('skips paused schedules', () => {
  const schedule = createSchedule(db, { title: 'Paused job', interval_days: 7 });
  updateSchedule(db, schedule.id, { paused: true });

  assert.equal(runSchedules(db).length, 0);
  // Resuming makes it eligible again without losing its place.
  updateSchedule(db, schedule.id, { paused: false });
  assert.equal(runSchedules(db).length, 1);
});

test('one broken schedule does not stop the others', () => {
  createSchedule(db, { title: 'Fine', interval_days: 7 });
  const broken = createSchedule(db, { title: 'Broken', interval_days: 7 });
  // An interval of zero cannot reach a future date; the runner must not hang
  // or abandon the sweep because of it.
  db.prepare('UPDATE schedules SET interval_days = 0 WHERE id = ?').run(broken.id);

  const fired = runSchedules(db);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].ticket.title, 'Fine');
});

test('fires against a device deleted since the schedule was written', () => {
  const device = createDevice(db, { name: 'old-nas', type: 'nas' });
  createSchedule(db, { title: 'Check the old NAS', interval_days: 30, device_id: device.id });
  db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);

  const fired = runSchedules(db);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].ticket.device_id, null);
});

/* ---- Listing and deleting ------------------------------------------------ */

test('lists active schedules before paused ones, soonest first', () => {
  const later = createSchedule(db, { title: 'Later', interval_days: 30 });
  setDue(later.id, daysFromNow(20));
  const sooner = createSchedule(db, { title: 'Sooner', interval_days: 30 });
  setDue(sooner.id, daysFromNow(2));
  const paused = createSchedule(db, { title: 'Paused', interval_days: 30 });
  updateSchedule(db, paused.id, { paused: true });

  assert.deepEqual(
    listSchedules(db).map((s) => s.title),
    ['Sooner', 'Later', 'Paused'],
  );
});

test('reports how many days until each schedule is due', () => {
  const schedule = createSchedule(db, { title: 'Soon', interval_days: 30 });
  setDue(schedule.id, daysFromNow(5));
  assert.equal(listSchedules(db)[0].due_in_days, 5);

  setDue(schedule.id, daysFromNow(-3));
  assert.equal(listSchedules(db)[0].due_in_days, -3);
});

test('filters by paused state and device', () => {
  const device = createDevice(db, { name: 'pve-01', type: 'server' });
  createSchedule(db, { title: 'On the box', interval_days: 30, device_id: device.id });
  const paused = createSchedule(db, { title: 'Elsewhere', interval_days: 30 });
  updateSchedule(db, paused.id, { paused: true });

  assert.deepEqual(listSchedules(db, { paused: 'true' }).map((s) => s.title), ['Elsewhere']);
  assert.deepEqual(listSchedules(db, { paused: 'false' }).map((s) => s.title), ['On the box']);
  assert.deepEqual(
    listSchedules(db, { device_id: String(device.id) }).map((s) => s.title),
    ['On the box'],
  );
});

test('deleting a schedule keeps its tickets and unlinks them', () => {
  const schedule = createSchedule(db, { title: 'Quarterly audit', interval_days: 90 });
  const [{ ticket }] = runSchedules(db);

  deleteSchedule(db, schedule.id);

  assert.equal(getTicket(db, ticket.id).schedule_id, null);
  assert.throws(() => getSchedule(db, schedule.id), /No schedule with id/);
});

test('a schedule lists the tickets it has generated', () => {
  const schedule = createSchedule(db, { title: 'Repeating', interval_days: 1 });

  runSchedules(db);
  setDue(schedule.id, today());
  runSchedules(db);

  assert.equal(getSchedule(db, schedule.id).tickets.length, 2);
});

/* ---- Transaction nesting ------------------------------------------------- */

test('firing composes with an outer transaction', () => {
  createSchedule(db, { title: 'Nested', interval_days: 30 });

  // runSchedules opens its own transaction per schedule; wrapping the whole
  // sweep in another one must not trip SQLite's lack of nested BEGIN.
  const fired = transaction(db, () => runSchedules(db));
  assert.equal(fired.length, 1);
});

test('a failure inside a nested transaction rolls back only its own work', () => {
  const device = createDevice(db, { name: 'keeper', type: 'server' });

  assert.throws(() =>
    transaction(db, () => {
      createDevice(db, { name: 'inner', type: 'server' });
      transaction(db, () => {
        throw new Error('inner failure');
      });
    }),
  );

  // The outer transaction rolled back too, so only the pre-existing row remains.
  assert.deepEqual(
    db.prepare('SELECT name FROM devices ORDER BY id').all().map((r) => r.name),
    [device.name],
  );
});
