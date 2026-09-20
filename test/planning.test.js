import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  createTicket,
  getTicket,
  updateTicket,
  bulkUpdateTickets,
  listTickets,
} from '../src/api/tickets.js';
import {
  projects,
  savedViews,
  checklist,
  orderToday,
} from '../src/api/planning.js';
import {
  createSchedule,
  getSchedule,
  runSchedules,
} from '../src/api/schedules.js';
import { nextOccurrence } from '../src/recurrence.js';
import { civilDate, addDays } from '../src/dates.js';
import { submitOnce } from '../src/submissions.js';

function database(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}
test('Today is ordered, persistent across dates, and independent of deadlines; bulk completion clears it', (t) => {
  const db = database(t);
  const a = createTicket(db, {
    title: 'A',
    queue: 'inbox',
    due_date: '2030-01-01',
    today: true,
  });
  const b = createTicket(db, { title: 'B', today: true });
  assert.equal(a.queue, 'next');
  assert.deepEqual(
    orderToday(db, { ids: [b.id, a.id] }).map((v) => v.id),
    [b.id, a.id],
  );
  assert.throws(() => orderToday(db, { ids: [b.id] }));
  updateTicket(db, a.id, { today: false });
  assert.equal(getTicket(db, a.id).due_date, '2030-01-01');
  bulkUpdateTickets(db, { ids: [a.id, b.id], status: 'resolved' });
  assert.equal(listTickets(db, { today: 'true' }).length, 0);
  updateTicket(db, a.id, { status: 'open' });
  assert.equal(getTicket(db, a.id).today_rank, null);
});
test('snooze and waiting visibility is derived at read time, with deadlines intact', (t) => {
  const db = database(t);
  const task = createTicket(db, {
    title: 'Follow up',
    waiting_on: 'Supplier',
    follow_up_date: '2000-01-01',
    due_date: '2000-01-02',
  });
  assert.equal(listTickets(db, { actionable: 'true' }).length, 1);
  updateTicket(db, task.id, { snoozed_until: '2099-01-01' });
  assert.equal(listTickets(db, { actionable: 'true' }).length, 0);
  assert.equal(listTickets(db, { snoozed: 'true' }).length, 1);
  assert.equal(listTickets(db, { due: 'overdue' }).length, 1);
  updateTicket(db, task.id, { today: true });
  assert.equal(getTicket(db, task.id).waiting_on, null);
  assert.equal(getTicket(db, task.id).snoozed_until, null);
});
test('projects, checklist progress and saved views persist without deleting tasks', (t) => {
  const db = database(t);
  const p = projects(
    db,
    null,
    { name: 'Migration', notes: '**Plan**' },
    'POST',
  );
  const task = createTicket(db, { title: 'Move disks', project_id: p.id });
  let items = checklist(db, task.id, null, { title: 'Backup' }, 'POST');
  checklist(db, task.id, items[0].id, { completed: true }, 'PATCH');
  assert.equal(getTicket(db, task.id).checklist_completed, 1);
  assert.equal(getTicket(db, task.id).is_open, true);
  assert.equal(projects(db, p.id).next_action.id, task.id);
  const v = savedViews(
    db,
    null,
    { name: 'Tech', filters: { project_id: p.id, status: 'all', due: 'none' } },
    'POST',
  );
  assert.equal(savedViews(db, v.id).filters.project_id, p.id);
  assert.throws(() =>
    savedViews(db, null, { name: 'Bad', filters: { sql: 'DELETE' } }, 'POST'),
  );
  projects(db, p.id, {}, 'DELETE');
  assert.equal(getTicket(db, task.id).project_id, null);
  assert.equal(getTicket(db, task.id).checklist_total, 1);
});
test('civil dates and recurrence cover DST, leap months and last weekdays', () => {
  assert.equal(
    civilDate(new Date('2026-03-08T06:59:00Z'), 'America/Denver'),
    '2026-03-07',
  );
  assert.equal(
    civilDate(new Date('2026-03-08T09:01:00Z'), 'America/Denver'),
    '2026-03-08',
  );
  assert.equal(
    nextOccurrence({ kind: 'monthly_date', day: 31 }, '2028-01-31'),
    '2028-02-29',
  );
  assert.equal(
    nextOccurrence(
      { kind: 'monthly_weekday', ordinal: 5, weekday: 0 },
      '2026-02-01',
    ),
    '2026-02-22',
  );
  assert.equal(
    nextOccurrence({ kind: 'weekly', weekdays: [1, 2, 3, 4, 5] }, '2026-09-18'),
    '2026-09-21',
  );
});
test('new routines create one open occurrence with fresh checklist; bulk completion arms the next one', (t) => {
  const db = database(t);
  const today = civilDate();
  const s = createSchedule(db, {
    title: 'Clean',
    next_due: today,
    recurrence: { kind: 'after_completion', days: 30 },
    checklist: ['Filter', 'Fan'],
  });
  const fired = runSchedules(db, { today });
  assert.equal(fired.length, 1);
  assert.equal(getTicket(db, fired[0].ticket.id).checklist_total, 2);
  assert.equal(runSchedules(db, { today: addDays(today, 90) }).length, 0);
  bulkUpdateTickets(db, { ids: [fired[0].ticket.id], status: 'resolved' });
  assert.equal(getSchedule(db, s.id).next_due, addDays(today, 30));
  updateTicket(db, fired[0].ticket.id, { title: 'Clean fan' });
  assert.equal(getSchedule(db, s.id).next_due, addDays(today, 30));
  updateTicket(db, fired[0].ticket.id, { status: 'open' });
  assert.equal(runSchedules(db, { today: addDays(today, 40) }).length, 0);
  updateTicket(db, fired[0].ticket.id, { status: 'resolved' });
  assert.equal(runSchedules(db, { today: addDays(today, 30) }).length, 1);
  assert.equal(runSchedules(db, { today: addDays(today, 30) }).length, 0);
});
test('capture retries are idempotent and reject payload changes after an uncertain response', (t) => {
  const db = database(t),
    key = '12345678-1234-1234-1234-123456789012';
  const create = () => createTicket(db, { title: 'Captured once' });
  const first = submitOnce(db, 'ticket', key, 'same', create, (id) =>
    getTicket(db, id),
  );
  const retry = submitOnce(db, 'ticket', key, 'same', create, (id) =>
    getTicket(db, id),
  );
  assert.equal(first.value.id, retry.value.id);
  assert.equal(retry.fresh, false);
  assert.equal(listTickets(db).length, 1);
  assert.throws(() =>
    submitOnce(db, 'ticket', key, 'changed', create, (id) => getTicket(db, id)),
  );
});

test('reopening and recompleting a calendar routine does not skip its next occurrence', (t) => {
  const db = database(t),
    today = civilDate();
  const schedule = createSchedule(db, {
    title: 'Weekly cleaning',
    next_due: today,
    recurrence: { kind: 'interval', days: 7 },
  });
  const task = runSchedules(db, { today })[0].ticket;
  updateTicket(db, task.id, { status: 'resolved' });
  const due = getSchedule(db, schedule.id).next_due;
  updateTicket(db, task.id, { status: 'open' });
  updateTicket(db, task.id, { status: 'resolved' });
  assert.equal(getSchedule(db, schedule.id).next_due, due);
});

test('reopening older history cannot generate a parallel unfinished recurrence', (t) => {
  const db = database(t),
    today = civilDate();
  const s = createSchedule(db, {
    title: 'Routine',
    next_due: today,
    recurrence: { kind: 'after_completion', days: 1 },
  });
  const first = runSchedules(db, { today })[0].ticket;
  updateTicket(db, first.id, { status: 'resolved' });
  const second = runSchedules(db, { today: addDays(today, 1) })[0].ticket;
  updateTicket(db, first.id, { status: 'open' });
  updateTicket(db, second.id, { status: 'resolved' });
  assert.equal(runSchedules(db, { today: addDays(today, 5) }).length, 0);
  assert.equal(getSchedule(db, s.id).last_ticket_id, second.id);
});
