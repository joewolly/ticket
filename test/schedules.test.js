import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, transaction } from '../src/db.js';
import { createDevice } from '../src/api/devices.js';
import { createTicket, getTicket, listTickets } from '../src/api/tickets.js';
import {
  listSchedules,
  getSchedule,
  getChoreRoster,
  updateHouseholdMember,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedules,
} from '../src/api/schedules.js';
import { syncRecurrence } from '../src/recurrence.js';
import { addDays } from '../src/dates.js';

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

const createChore = (title, next_due, weekdays = [0]) =>
  createSchedule(db, {
    title,
    next_due,
    interval_days: 7,
    recurrence: { kind: 'weekly', weekdays },
    is_chore: true,
  });
const createTicketForChoreTest = (title) => createTicket(db, { title });

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

test('chore opt-in is explicit and requires a modern recurrence', () => {
  const routine = createSchedule(db, { title: 'Routine', interval_days: 7 });
  assert.equal(routine.is_chore, false);
  assert.equal(routine.archived, false);
  assert.throws(
    () => createSchedule(db, { title: 'No cadence', is_chore: true }),
    /Chore schedules require a modern recurrence/,
  );
  assert.deepEqual(listSchedules(db, { is_chore: true }), []);
  assert.equal(listSchedules(db, { is_chore: false }).length, 1);
  const chore = createChore('Opted in at creation', '2026-09-20', [0]);
  assert.throws(
    () => updateSchedule(db, chore.id, { recurrence: null }),
    /Chore schedules require a modern recurrence/,
  );
  assert.ok(getSchedule(db, chore.id).recurrence);
  assert.throws(
    () => updateSchedule(db, chore.id, { is_chore: false }),
    /is_chore cannot be changed/,
  );
  assert.throws(
    () =>
      updateSchedule(db, routine.id, {
        is_chore: true,
        recurrence: { kind: 'weekly', weekdays: [2] },
      }),
    /is_chore cannot be changed/,
  );
  assert.equal(updateSchedule(db, chore.id, { archived: true }).archived, true);
  assert.throws(
    () => updateSchedule(db, chore.id, { archived: false }),
    /cannot be unarchived/,
  );
  assert.equal(updateSchedule(db, chore.id, { title: 'Archived title' }).archived, true);
  assert.equal(listSchedules(db, { is_chore: true, archived: true }).length, 1);
});

test('the persistent roster has two stable editable member IDs', () => {
  const initial = getChoreRoster(db, { today: '2026-09-25' });
  assert.deepEqual(initial.members, [
    { id: 1, name: 'Member 1' },
    { id: 2, name: 'Member 2' },
  ]);
  assert.deepEqual(updateHouseholdMember(db, 1, { name: 'Alex' }), {
    id: 1,
    name: 'Alex',
  });
  assert.equal(getChoreRoster(db, { today: '2026-09-25' }).members[0].id, 1);
  assert.throws(() => updateHouseholdMember(db, 1, { name: 'Member 2' }), /unique/);
});

test('chores cannot be converted from an existing ticket', () => {
  const task = createTicketForChoreTest('Existing task');
  assert.throws(
    () =>
      createSchedule(db, {
        title: 'Chore',
        is_chore: true,
        next_due: '2026-09-20',
        recurrence: { kind: 'weekly', weekdays: [0] },
        source_ticket_id: task.id,
      }),
    /cannot be created from an existing ticket/,
  );
  assert.equal(getTicket(db, task.id).schedule_id, null);
});

test('runSchedules can materialize chores without firing ordinary routines', () => {
  const routine = createSchedule(db, {
    title: 'Ordinary routine',
    next_due: '2026-09-20',
    interval_days: 7,
  });
  const chore = createChore('Household chore', '2026-09-20', [0]);

  const choresOnly = runSchedules(db, {
    today: '2026-09-20',
    onlyChores: true,
  });
  assert.deepEqual(
    choresOnly.map(({ schedule_id }) => schedule_id),
    [chore.id],
  );
  assert.equal(getSchedule(db, routine.id).last_ticket_id, null);
  assert.equal(listTickets(db).length, 1);

  const normalSweep = runSchedules(db, { today: '2026-09-20' });
  assert.deepEqual(
    normalSweep.map(({ schedule_id }) => schedule_id),
    [routine.id],
  );
});

test('Sunday commits known chores, balances assignment, and exposes later work conditionally', () => {
  const actualToday = today();
  const weekday = new Date(`${actualToday}T12:00:00Z`).getUTCDay();
  const weekStart = addDays(actualToday, -weekday);
  const daily = createChore('Daily dishes', weekStart, [0, 1, 2, 3, 4, 5, 6]);
  const weekly = createChore('Weekly floors', weekStart, [0]);

  const fired = runSchedules(db, { today: weekStart });
  assert.deepEqual(
    fired.map(({ ticket }) => ticket.assignee_id),
    [1, 2],
    'the initial load is split between the two members',
  );
  assert.ok(fired.every(({ ticket }) => ticket.original_due_date === weekStart));
  assert.ok(fired.every(({ ticket }) => ticket.events.some((e) => e.kind === 'assignee')));
  assert.equal(runSchedules(db, { today: addDays(weekStart, 1) }).length, 0);

  const roster = getChoreRoster(db, { week: weekStart, today: weekStart });
  assert.equal(roster.week_start, weekStart);
  assert.equal(roster.week_end, addDays(weekStart, 6));
  assert.deepEqual(
    roster.assignments.map(({ assignee_id }) => assignee_id),
    [1, 2],
  );
  assert.deepEqual(roster.previews, [
    {
      schedule_id: daily.id,
      title: 'Daily dishes',
      due_date: addDays(weekStart, 1),
      conditional: true,
    },
  ]);
  assert.equal(roster.chores.find((chore) => chore.id === weekly.id).is_chore, true);
});

test('completion enables a later weekly occurrence without backfilling a missed one', () => {
  const actualToday = today();
  const actualWeekday = new Date(`${actualToday}T12:00:00Z`).getUTCDay();
  const weekStart = addDays(actualToday, -actualWeekday);
  const schedule = createChore(
    'Daily counter',
    weekStart,
    [0, 1, 2, 3, 4, 5, 6],
  );
  const first = runSchedules(db, { today: weekStart })[0].ticket;

  // Complete on the day before the injected current day; the successor is
  // therefore a known current-week occurrence, not historical catch-up.
  db.prepare(
    "UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?",
  ).run(`${addDays(actualToday, -1)} 12:00:00`, first.id);
  syncRecurrence(db, first.id);
  assert.equal(getSchedule(db, schedule.id).next_due, actualToday);

  const next = runSchedules(db, { today: actualToday });
  assert.equal(next.length, 1);
  assert.equal(next[0].ticket.original_due_date, actualToday);
  assert.notEqual(next[0].ticket.assignee_id, first.assignee_id);

  // A Monday missed while offline is skipped to the next occurrence in this
  // week, rather than being materialized with a historical due date.
  const midweek = createChore('Midweek laundry', '2026-09-21', [1, 4]);
  const missed = runSchedules(db, { today: '2026-09-22' });
  const laundry = missed.find(({ schedule_id }) => schedule_id === midweek.id);
  assert.equal(laundry.ticket.original_due_date, '2026-09-24');
});

test('roster browsing is read-only, validates Sunday starts, and only creates within this week', () => {
  const schedule = createChore('Future chore', '2026-09-27', [0]);
  const before = getSchedule(db, schedule.id).next_due;
  assert.throws(
    () => getChoreRoster(db, { week: '2026-09-21', today: '2026-09-25' }),
    /week must be a Sunday/,
  );
  const past = getChoreRoster(db, { week: '2026-09-20', today: '2026-09-25' });
  assert.equal(past.assignments.length, 0);
  assert.equal(getSchedule(db, schedule.id).next_due, before);
  assert.equal(runSchedules(db, { today: '2026-09-25' }).length, 0);
  assert.equal(listTickets(db).length, 0);
});

test('deleting a chore archives it and retains its open assignment history', () => {
  const schedule = createChore('Keep the entry clear', '2026-09-20', [0]);
  const [{ ticket }] = runSchedules(db, { today: '2026-09-20' });

  deleteSchedule(db, schedule.id);

  assert.equal(getSchedule(db, schedule.id).archived, true);
  assert.equal(getTicket(db, ticket.id).assignee_id, 1);
  assert.equal(getChoreRoster(db, { week: '2026-09-20', today: '2026-09-20' }).assignments.length, 1);
  assert.equal(runSchedules(db, { today: '2026-09-27' }).length, 0);
  assert.equal(listSchedules(db, { archived: true }).length, 1);
});

test('an overdue open chore retains its original owner and date as a carryover', () => {
  const prior = createChore('Old chore', '2026-09-13', [0]);
  const [{ ticket: overdue }] = runSchedules(db, { today: '2026-09-13' });
  const next = createChore('New week chore', '2026-09-20', [0]);

  const created = runSchedules(db, { today: '2026-09-20' });
  const current = created.find(({ schedule_id }) => schedule_id === next.id).ticket;
  db.prepare('UPDATE tickets SET due_date = ? WHERE id = ?').run(
    '2026-09-28',
    overdue.id,
  );
  const roster = getChoreRoster(db, {
    week: '2026-09-20',
    today: '2026-09-20',
  });
  const carried = roster.assignments.find(({ id }) => id === overdue.id);
  assert.equal(carried.assignee_id, overdue.assignee_id);
  assert.equal(carried.original_due_date, '2026-09-13');
  assert.equal(carried.due_date, '2026-09-28');
  assert.notEqual(
    current.assignee_id,
    overdue.assignee_id,
    'the carryover shifts new work to the less-loaded member',
  );
  assert.ok(roster.chores.some(({ id }) => id === prior.id));
});

test('historical chore starts advance to the current week without backfilling', () => {
  const actualToday = today();
  const weekday = new Date(`${actualToday}T12:00:00Z`).getUTCDay();
  const oldStart = addDays(actualToday, -45);
  const schedule = createChore('Historical start', oldStart, [weekday]);

  const [{ ticket }] = runSchedules(db, { today: actualToday });
  assert.equal(ticket.schedule_id, schedule.id);
  assert.equal(ticket.due_date, actualToday);
  assert.equal(ticket.original_due_date, actualToday);
});

test('fair final tie-break varies by schedule rather than favoring the lower member ID', () => {
  const firstWeek = '2026-01-04';
  const firstSchedule = createChore('First fair chore', firstWeek, [0]);
  const [first] = runSchedules(db, { today: firstWeek });
  db.prepare(
    "UPDATE tickets SET status = 'resolved', resolved_at = '2026-01-04 12:00:00' WHERE id = ?",
  ).run(first.ticket.id);
  deleteSchedule(db, firstSchedule.id);

  const secondWeek = '2026-02-15';
  const secondSchedule = createChore('Second fair chore', secondWeek, [0]);
  const laterFired = runSchedules(db, { today: secondWeek });
  assert.deepEqual(
    laterFired.map(({ schedule_id }) => schedule_id),
    [secondSchedule.id],
    'the completed archived recurrence is not generated again',
  );
  const [second] = laterFired;

  assert.notEqual(
    first.ticket.assignee_id,
    second.ticket.assignee_id,
    'with no current or prior-four-week load and no schedule-specific prior owner, the tie shifts',
  );
  assert.equal(second.schedule_id, secondSchedule.id);
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
