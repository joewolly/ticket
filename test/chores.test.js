import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  createSchedule,
  getChoreRoster,
  getSchedule,
  runSchedules,
  updateSchedule,
} from '../src/api/schedules.js';
import { createTicket, updateTicket } from '../src/api/tickets.js';
import { configureDates } from '../src/dates.js';
import { syncRecurrence } from '../src/recurrence.js';

function database(t, timeZone = 'UTC') {
  const db = openDatabase(':memory:');
  configureDates(db, timeZone);
  t.after(() => db.close());
  return db;
}

function createChore(db, { title, next_due, recurrence, ...fields }) {
  return createSchedule(db, {
    title,
    next_due,
    recurrence,
    is_chore: true,
    time_zone: 'UTC',
    ...fields,
  });
}

function completeAt(db, ticket, date) {
  db.prepare(
    "UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?",
  ).run(`${date} 12:00:00`, ticket.id);
  syncRecurrence(db, ticket.id);
}

test('chore recurrence supports selected weekdays, monthly rules, intervals, and completion-based dates', async (t) => {
  const cases = [
    {
      name: 'weekly selected days',
      next_due: '2030-01-01',
      recurrence: { kind: 'weekly', weekdays: [2, 5] },
      due: '2030-01-01',
      completed: '2030-01-01',
      next: '2030-01-04',
    },
    {
      name: 'monthly date clamps to leap-day',
      next_due: '2032-01-31',
      recurrence: { kind: 'monthly_date', day: 31 },
      due: '2032-01-31',
      completed: '2032-01-31',
      next: '2032-02-29',
    },
    {
      name: 'monthly fifth weekday means the last weekday',
      next_due: '2030-01-01',
      recurrence: { kind: 'monthly_weekday', ordinal: 5, weekday: 0 },
      due: '2030-01-27',
      completed: '2030-01-27',
      next: '2030-02-24',
    },
    {
      name: 'interval cadence remains anchored to its due date',
      next_due: '2030-03-01',
      recurrence: { kind: 'interval', days: 4 },
      due: '2030-03-01',
      completed: '2030-03-05',
      next: '2030-03-09',
    },
    {
      name: 'after-completion cadence starts from completion',
      next_due: '2030-04-01',
      recurrence: { kind: 'after_completion', days: 7 },
      due: '2030-04-01',
      completed: '2030-04-05',
      next: '2030-04-12',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, (t) => {
      const db = database(t);
      const schedule = createChore(db, {
        title: scenario.name,
        next_due: scenario.next_due,
        recurrence: scenario.recurrence,
      });

      const [first] = runSchedules(db, { today: scenario.due });
      assert.equal(first.schedule_id, schedule.id);
      assert.equal(first.ticket.original_due_date, scenario.due);

      completeAt(db, first.ticket, scenario.completed);
      assert.equal(getSchedule(db, schedule.id).next_due, scenario.next);
    });
  }
});

test('multi-weekday preview advances conditionally and completion enables another same-week chore', (t) => {
  const db = database(t);
  const week = '2030-01-06'; // Sunday
  const schedule = createChore(db, {
    title: 'Monday Wednesday Friday chore',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [1, 3, 5] },
  });

  const before = getChoreRoster(db, { week, today: week });
  assert.deepEqual(
    before.previews.map(({ schedule_id, due_date, conditional }) => ({
      schedule_id,
      due_date,
      conditional,
    })),
    [{ schedule_id: schedule.id, due_date: '2030-01-07', conditional: true }],
  );

  const [monday] = runSchedules(db, { today: '2030-01-07' });
  assert.equal(monday.ticket.original_due_date, '2030-01-07');
  const whileOpen = getChoreRoster(db, { week, today: '2030-01-07' });
  assert.deepEqual(
    whileOpen.previews.map(({ schedule_id, due_date, conditional }) => ({
      schedule_id,
      due_date,
      conditional,
    })),
    [{ schedule_id: schedule.id, due_date: '2030-01-09', conditional: true }],
  );

  completeAt(db, monday.ticket, '2030-01-07');
  const [wednesday] = runSchedules(db, { today: '2030-01-09' });
  assert.equal(wednesday.schedule_id, schedule.id);
  assert.equal(wednesday.ticket.original_due_date, '2030-01-09');
  assert.equal(wednesday.ticket.assignee_id, monday.ticket.assignee_id === 1 ? 2 : 1);
});

test('manual reassignment changes the next actual owner and roster week load', (t) => {
  const db = database(t);
  const week = '2030-01-06'; // Sunday
  const recurring = createChore(db, {
    title: 'Reassigned Monday Wednesday chore',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [1, 3] },
  });
  createChore(db, {
    title: 'Second Monday chore',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [1] },
  });

  const monday = runSchedules(db, { today: '2030-01-07' });
  assert.equal(monday.length, 2);
  const first = monday.find(({ schedule_id }) => schedule_id === recurring.id).ticket;
  const second = monday.find(({ schedule_id }) => schedule_id !== recurring.id).ticket;
  assert.notEqual(first.assignee_id, second.assignee_id);

  const firstOwner = first.assignee_id;
  const secondOwner = second.assignee_id;
  updateTicket(db, first.id, { assignee_id: secondOwner });
  updateTicket(db, second.id, { assignee_id: firstOwner });

  const reassignedRoster = getChoreRoster(db, { week, today: '2030-01-07' });
  const counts = new Map([[1, 0], [2, 0]]);
  for (const assignment of reassignedRoster.assignments)
    counts.set(assignment.assignee_id, counts.get(assignment.assignee_id) + 1);
  assert.deepEqual([...counts.values()], [1, 1]);
  assert.equal(
    reassignedRoster.assignments.find(({ id }) => id === first.id).assignee_id,
    secondOwner,
  );

  completeAt(db, first, '2030-01-07');
  const wednesday = runSchedules(db, { today: '2030-01-09' }).find(
    ({ schedule_id }) => schedule_id === recurring.id,
  );
  assert.ok(wednesday);
  assert.equal(
    wednesday.ticket.assignee_id,
    firstOwner,
    'with equal week loads, the next occurrence avoids the manually selected last owner',
  );
});

test('the four prior weeks compensate an otherwise tied chore assignment', (t) => {
  const db = database(t);
  const week = '2030-02-03'; // Sunday
  const history = createChore(db, {
    title: 'Historical assignments',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [0] },
    paused: true,
  });

  for (const date of [
    '2030-01-06', // exactly four weeks before; the lower edge is included
    '2030-01-13',
    '2030-01-20',
    '2030-01-27',
  ]) {
    const ticket = createTicket(
      db,
      { title: `Recent work ${date}`, due_date: date },
      { scheduleId: history.id },
    );
    db.prepare(
      "UPDATE tickets SET assignee_id = 1, original_due_date = ?, status = 'resolved', resolved_at = ? WHERE id = ?",
    ).run(date, `${date} 12:00:00`, ticket.id);
  }

  // This fifth-prior-week assignment must not outweigh the four in-window
  // assignments above.
  const old = createTicket(
    db,
    { title: 'Out-of-window work', due_date: '2029-12-30' },
    { scheduleId: history.id },
  );
  db.prepare(
    "UPDATE tickets SET assignee_id = 2, original_due_date = '2029-12-30', status = 'resolved', resolved_at = '2029-12-30 12:00:00' WHERE id = ?",
  ).run(old.id);

  const current = createChore(db, {
    title: 'Current tie-break chore',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [0] },
  });
  const [created] = runSchedules(db, { today: week, onlyChores: true });
  assert.equal(created.schedule_id, current.id);
  assert.equal(created.ticket.assignee_id, 2);
});

test('archiving preserves the open assignment and prevents future occurrences', (t) => {
  const db = database(t);
  const week = '2030-06-02'; // Sunday
  const schedule = createChore(db, {
    title: 'Keep this open assignment',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [0] },
  });
  const [created] = runSchedules(db, { today: week });

  updateSchedule(db, schedule.id, { archived: true });
  const currentWeek = getChoreRoster(db, { week, today: week });
  assert.equal(
    currentWeek.assignments.some(({ id }) => id === created.ticket.id),
    true,
  );
  assert.equal(
    currentWeek.previews.some(({ schedule_id }) => schedule_id === schedule.id),
    false,
  );

  const nextWeek = '2030-06-09';
  const futureRoster = getChoreRoster(db, { week: nextWeek, today: nextWeek });
  assert.deepEqual(
    futureRoster.assignments.map(({ id }) => id),
    [created.ticket.id],
    'the still-open ticket is a carryover, not a new occurrence',
  );
  assert.equal(
    futureRoster.previews.some(({ schedule_id }) => schedule_id === schedule.id),
    false,
  );
  assert.equal(runSchedules(db, { today: nextWeek }).length, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE schedule_id = ?').get(schedule.id)
      .count,
    1,
  );
});

test('ordinary routines and their tickets are absent from the chore roster', (t) => {
  const db = database(t);
  const week = '2030-02-03'; // Sunday
  const ordinary = createSchedule(db, {
    title: 'Ordinary Monday routine',
    next_due: '2030-02-04',
    interval_days: 7,
  });
  const chore = createChore(db, {
    title: 'Chore Monday routine',
    next_due: week,
    recurrence: { kind: 'weekly', weekdays: [1] },
  });
  const fired = runSchedules(db, { today: '2030-02-04' });
  assert.equal(fired.length, 2);

  const roster = getChoreRoster(db, { week, today: '2030-02-04' });
  assert.deepEqual(roster.chores.map(({ id }) => id), [chore.id]);
  assert.deepEqual(
    roster.assignments.map(({ schedule_id }) => schedule_id),
    [chore.id],
  );
  assert.equal(roster.assignments.some(({ schedule_id }) => schedule_id === ordinary.id), false);
});

test('the roster Sunday boundary follows the configured app time zone', (t) => {
  const db = database(t, 'America/Los_Angeles');
  const beforeLocalSunday = getChoreRoster(db, {
    today: new Date('2026-09-20T06:59:00Z'), // Saturday 23:59 in Los Angeles
  });
  assert.equal(beforeLocalSunday.today, '2026-09-19');
  assert.equal(beforeLocalSunday.week_start, '2026-09-13');

  const afterLocalMidnight = getChoreRoster(db, {
    today: new Date('2026-09-20T07:01:00Z'), // Sunday 00:01 in Los Angeles
  });
  assert.equal(afterLocalMidnight.today, '2026-09-20');
  assert.equal(afterLocalMidnight.week_start, '2026-09-20');
});

test('chore time zones are fixed to the app zone while ordinary routines keep custom zones', (t) => {
  const db = database(t, 'America/Los_Angeles');
  const recurrence = { kind: 'weekly', weekdays: [1] };

  assert.throws(
    () =>
      createSchedule(db, {
        title: 'Mismatched chore',
        is_chore: true,
        next_due: '2026-09-21',
        recurrence,
        time_zone: 'UTC',
      }),
    /Chore time_zone must match the application time zone/,
  );

  const chore = createSchedule(db, {
    title: 'App-zone chore',
    is_chore: true,
    next_due: '2026-09-21',
    recurrence,
  });
  assert.equal(chore.time_zone, 'America/Los_Angeles');
  assert.throws(
    () => updateSchedule(db, chore.id, { time_zone: 'UTC' }),
    /Chore time_zone must match the application time zone/,
  );
  assert.equal(getSchedule(db, chore.id).time_zone, 'America/Los_Angeles');

  const routine = createSchedule(db, {
    title: 'Custom-zone routine',
    next_due: '2026-09-21',
    recurrence,
    time_zone: 'UTC',
  });
  assert.equal(routine.time_zone, 'UTC');
  assert.equal(
    updateSchedule(db, routine.id, { time_zone: 'America/New_York' }).time_zone,
    'America/New_York',
  );
});

test('chore materialization uses the app-zone date at the Sunday boundary', (t) => {
  const db = database(t, 'America/Los_Angeles');
  const chore = createSchedule(db, {
    title: 'Saturday chore',
    is_chore: true,
    next_due: '2026-09-19',
    recurrence: { kind: 'weekly', weekdays: [6] },
  });
  assert.equal(chore.time_zone, 'America/Los_Angeles');

  // Simulate a legacy row created before chore time zones were constrained.
  db.prepare('UPDATE schedules SET time_zone = ? WHERE id = ?').run(
    'UTC',
    chore.id,
  );

  const RealDate = globalThis.Date;
  const frozenNow = RealDate.parse('2026-09-20T06:59:00Z'); // Saturday 23:59 in Los Angeles
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozenNow]));
    }

    static now() {
      return frozenNow;
    }
  };
  try {
    const [created] = runSchedules(db);
    assert.equal(created.schedule_id, chore.id);
    assert.equal(created.ticket.original_due_date, '2026-09-19');
  } finally {
    globalThis.Date = RealDate;
  }
});
