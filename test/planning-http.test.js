import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { runBackup } from '../src/backup.js';
import {
  createTicket,
  getTicket,
  updateTicket,
  bulkUpdateTickets,
} from '../src/api/tickets.js';
import { projects, savedViews, checklist } from '../src/api/planning.js';
import {
  createSchedule,
  getSchedule,
  getChoreRoster,
  runSchedules,
} from '../src/api/schedules.js';
import { addAttachment, getAttachment } from '../src/api/attachments.js';
import { createNotifier } from '../src/notify.js';
import { getStats } from '../src/api/stats.js';
import { renderCalendar } from '../src/api/calendar.js';
import { civilDate, addDays } from '../src/dates.js';

async function server(t, env = {}) {
  const db = openDatabase(':memory:'),
    app = createServer(
      db,
      loadConfig({ AUTH_PASSWORD: 'planning-test-password', ...env }),
    );
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'planning-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { db, request };
}

test('configured civil time zone drives planning filters and new routines', async (t) => {
  const zone = 'Pacific/Kiritimati';
  const { request } = await server(t, { APP_TIME_ZONE: zone });
  const planning = JSON.parse((await request('/api/planning')).text);
  assert.equal(planning.time_zone, zone);
  assert.equal(planning.today, civilDate(new Date(), zone));
  const task = JSON.parse(
    (
      await request('/api/tickets', 'POST', {
        title: 'Local calendar deadline',
        due_date: planning.today,
      })
    ).text,
  );
  assert.ok(
    JSON.parse((await request('/api/tickets?due=today')).text).some(
      (row) => row.id === task.id,
    ),
  );
  const routine = await request('/api/schedules', 'POST', {
    title: 'Local routine',
    recurrence: { kind: 'monthly_date', day: 31 },
  });
  assert.equal(routine.status, 201);
  assert.equal(JSON.parse(routine.text).time_zone, zone);
  const legacy = await request('/api/schedules', 'POST', {
    title: 'Legacy interval',
    interval_days: 7,
  });
  assert.equal(legacy.status, 201);
  assert.equal(JSON.parse(legacy.text).time_zone, 'UTC');
});

test('chore HTTP integration keeps assignment, roster, and occurrence history coherent', async (t) => {
  const { db, request } = await server(t);
  const members = db.prepare('SELECT id FROM household_members ORDER BY id').all();
  assert.equal(members.length, 2, 'the household has two assignable members');
  const names = ['Chore Member One', 'Chore Member Two'];
  for (let i = 0; i < members.length; i++) {
    const renamed = await request(`/api/chores/members/${members[i].id}`, 'PATCH', {
      name: names[i],
    });
    assert.equal(renamed.status, 200);
    assert.equal(JSON.parse(renamed.text).name, names[i]);
  }

  const today = JSON.parse((await request('/api/planning')).text).today;
  const week = addDays(
    today,
    -new Date(`${today}T12:00:00Z`).getUTCDay(),
  );
  const created = await request('/api/schedules', 'POST', {
    title: 'Wash the towels',
    is_chore: true,
    recurrence: { kind: 'interval', days: 7 },
    next_due: today,
  });
  assert.equal(created.status, 201);
  const schedule = JSON.parse(created.text);
  assert.equal(schedule.is_chore, true);

  const rosterResponse = await request(`/api/chores?week=${week}`);
  assert.equal(rosterResponse.status, 200);
  const roster = JSON.parse(rosterResponse.text);
  assert.deepEqual(
    roster,
    JSON.parse(JSON.stringify(getChoreRoster(db, { week }))),
  );

  let occurrences = db
    .prepare('SELECT id FROM tickets WHERE schedule_id = ? ORDER BY id')
    .all(schedule.id);
  assert.equal(occurrences.length, 1, 'a roster read materializes one occurrence');
  const firstId = occurrences[0].id;
  let first = JSON.parse((await request(`/api/tickets/${firstId}`)).text);
  assert.equal(first.is_chore, true);
  assert.ok(members.some((member) => member.id === first.assignee_id));
  assert.equal(
    first.assignee_name,
    names[members.findIndex((member) => member.id === first.assignee_id)],
  );

  const assignedTo = members.find((member) => member.id !== first.assignee_id);
  const changed = await request(`/api/tickets/${firstId}`, 'PATCH', {
    assignee_id: assignedTo.id,
  });
  assert.equal(changed.status, 200);
  first = JSON.parse(changed.text);
  assert.equal(first.assignee_id, assignedTo.id);
  assert.equal(first.assignee_name, names[members.findIndex((m) => m.id === assignedTo.id)]);
  const assigneeEvent = first.events
    .filter((event) => event.kind === 'assignee')
    .at(-1);
  assert.deepEqual(
    [assigneeEvent?.from_value, assigneeEvent?.to_value],
    [names[members.findIndex((m) => m.id !== assignedTo.id)], first.assignee_name],
  );
  const listed = JSON.parse((await request('/api/tickets?status=all')).text);
  assert.equal(listed.find((ticket) => ticket.id === firstId).assignee_name, first.assignee_name);
  const reassignedRoster = JSON.parse(
    (await request(`/api/chores?week=${week}`)).text,
  );
  const rosterAssignment = reassignedRoster.assignments.find(
    (assignment) => assignment.id === firstId,
  );
  assert.equal(rosterAssignment.assignee_id, assignedTo.id);
  assert.equal(rosterAssignment.assignee_name, first.assignee_name);

  assert.equal(
    (await request('/api/tickets', 'POST', {
      title: 'Untrusted assignment',
      assignee_id: members[0].id,
    })).status,
    400,
    'public ticket creation cannot claim an assignee',
  );
  const ordinary = JSON.parse(
    (await request('/api/tickets', 'POST', { title: 'Ordinary task' })).text,
  );
  assert.equal(
    (await request(`/api/tickets/${ordinary.id}`, 'PATCH', {
      assignee_id: members[0].id,
    })).status,
    400,
    'ordinary tickets cannot be assigned',
  );
  assert.equal(
    (await request(`/api/tickets/${firstId}`, 'PATCH', { assignee_id: 999999 })).status,
    400,
    'assignments must reference a household member',
  );

  assert.equal((await request(`/api/tickets/${firstId}`, 'PATCH', { status: 'closed' })).status, 200);
  // Reading again cannot rematerialize the same scheduled date from history.
  await request(`/api/chores?week=${week}`);
  await request(`/api/chores?week=${week}`);
  occurrences = db
    .prepare('SELECT id, status FROM tickets WHERE schedule_id = ? ORDER BY id')
    .all(schedule.id);
  assert.equal(occurrences.length, 1, 'the same occurrence is not duplicated');

  // Model a later generated occurrence while keeping this test independent of
  // which weekday the test happens to run on.
  const newerTicket = createTicket(
    db,
    { title: 'Later towel occurrence', due_date: addDays(today, 1) },
    { scheduleId: schedule.id },
  );
  db.prepare(
    'UPDATE tickets SET assignee_id = ?, original_due_date = ? WHERE id = ?',
  ).run(assignedTo.id, addDays(today, 1), newerTicket.id);

  assert.equal(
    (await request(`/api/tickets/${firstId}`, 'PATCH', { status: 'open' })).status,
    400,
    'an older chore cannot reopen ahead of a newer unfinished occurrence',
  );
  assert.equal(
    (await request('/api/tickets/bulk', 'POST', {
      ids: [firstId, newerTicket.id],
      status: 'open',
    })).status,
    400,
    'bulk reopening uses the same chore guard',
  );
  assert.equal(JSON.parse((await request(`/api/tickets/${firstId}`)).text).status, 'closed');

  assert.equal(
    (await request(`/api/schedules/${schedule.id}`, 'PATCH', { archived: true })).status,
    200,
  );
  assert.equal(
    (await request(`/api/tickets/${firstId}`, 'DELETE')).status,
    400,
    'archiving the schedule does not make generated history deletable',
  );
  assert.equal((await request(`/api/tickets/${firstId}`)).status, 200);
  assert.equal((await request(`/api/tickets/${ordinary.id}`, 'DELETE')).status, 204);
});

test('chore roster reads only materialize current-week chores; maintenance fires routines', async (t) => {
  const { db, request } = await server(t);
  const { today } = JSON.parse((await request('/api/planning')).text);
  const currentWeek = addDays(
    today,
    -new Date(`${today}T12:00:00Z`).getUTCDay(),
  );
  const pastWeek = addDays(currentWeek, -7);
  const invalidWeek = addDays(currentWeek, 1);

  const choreResponse = await request('/api/schedules', 'POST', {
    title: 'Current-week chore',
    is_chore: true,
    recurrence: { kind: 'interval', days: 7 },
    next_due: today,
  });
  assert.equal(choreResponse.status, 201);
  const choreId = JSON.parse(choreResponse.text).id;
  const routineResponse = await request('/api/schedules', 'POST', {
    title: 'Ordinary routine',
    recurrence: { kind: 'interval', days: 7 },
    next_due: today,
  });
  assert.equal(routineResponse.status, 201);
  const routineId = JSON.parse(routineResponse.text).id;
  const occurrences = (scheduleId) =>
    db
      .prepare('SELECT id FROM tickets WHERE schedule_id = ? ORDER BY id')
      .all(scheduleId);

  const pastRosterResponse = await request(`/api/chores?week=${pastWeek}`);
  assert.equal(pastRosterResponse.status, 200);
  assert.equal(JSON.parse(pastRosterResponse.text).week_start, pastWeek);
  assert.deepEqual(occurrences(choreId), [], 'past roster reads do not fire chores');
  assert.deepEqual(
    occurrences(routineId),
    [],
    'past roster reads do not fire ordinary routines',
  );

  assert.equal(
    (await request(`/api/chores?week=${invalidWeek}`)).status,
    400,
    'a non-Sunday week is rejected',
  );
  assert.deepEqual(occurrences(choreId), [], 'invalid weeks do not fire chores');
  assert.deepEqual(
    occurrences(routineId),
    [],
    'invalid weeks do not fire ordinary routines',
  );

  const currentRosterResponse = await request(`/api/chores?week=${currentWeek}`);
  assert.equal(currentRosterResponse.status, 200);
  const currentRoster = JSON.parse(currentRosterResponse.text);
  assert.equal(currentRoster.week_start, currentWeek);
  assert.equal(occurrences(choreId).length, 1, 'current roster reads fire due chores');
  assert.deepEqual(
    occurrences(routineId),
    [],
    'current roster reads do not fire ordinary routines',
  );

  const maintenanceResponse = await request('/api/maintenance/run', 'POST');
  assert.equal(maintenanceResponse.status, 200);
  const maintenance = JSON.parse(maintenanceResponse.text);
  const routineFired = maintenance.schedules_fired.find(
    (entry) => entry.schedule_id === routineId,
  );
  assert.ok(routineFired, 'manual maintenance still fires ordinary routines');
  assert.equal(occurrences(routineId).length, 1);
  assert.equal(occurrences(routineId)[0].id, routineFired.ticket_id);
});

test('HTTP planning CRUD, order and saved-view filters execute the public contract', async (t) => {
  const { request } = await server(t);
  let res = await request('/api/projects', 'POST', { name: 'Office' });
  assert.equal(res.status, 201);
  const p = JSON.parse(res.text);
  res = await request('/api/tickets', 'POST', {
    title: 'Desk',
    project_id: p.id,
    today: true,
  });
  const task = JSON.parse(res.text);
  assert.equal(res.status, 201);
  assert.equal(
    (await request('/api/tickets/today/order', 'PUT', { ids: [task.id] }))
      .status,
    200,
  );
  res = await request(`/api/tickets/${task.id}/checklist`, 'POST', {
    title: 'Measure',
  });
  assert.equal(res.status, 201);
  const item = JSON.parse(res.text)[0];
  assert.equal(
    (
      await request(`/api/tickets/${task.id}/checklist/${item.id}`, 'PATCH', {
        completed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/tickets/${task.id}/checklist/order`, 'PUT', {
        ids: [item.id],
      })
    ).status,
    200,
  );
  res = await request('/api/views', 'POST', {
    name: 'Office work',
    filters: { project_id: p.id, queue: 'next', q: 'Desk', due: 'none' },
  });
  const v = JSON.parse(res.text);
  assert.equal(res.status, 201);
  assert.equal(
    (await request('/api/views/order', 'PUT', { ids: [v.id] })).status,
    200,
  );
  assert.equal(
    JSON.parse(
      (await request('/api/tickets?' + new URLSearchParams(v.filters))).text,
    ).length,
    1,
  );
  assert.equal((await request('/api/tickets?today=maybe')).status, 400);
  assert.equal(
    (
      await request('/api/tickets', 'POST', {
        title: 'Invalid date',
        snoozed_until: '2026-02-31',
      })
    ).status,
    400,
  );
  assert.equal((await request(`/api/projects/${p.id}`, 'DELETE')).status, 204);
  const kept = JSON.parse((await request(`/api/tickets/${task.id}`)).text);
  assert.equal(kept.project_id, null);
  assert.equal(kept.checklist_completed, 1);
  for (const entity of [
    'tickets',
    'projects',
    'views',
    'checklists',
    'schedules',
  ])
    assert.equal((await request(`/api/export?entity=${entity}`)).status, 200);
});

test('lost HTTP responses and concurrent retries cannot duplicate tasks or attachment bytes', async (t) => {
  const { request } = await server(t),
    key = randomUUID();
  const create = () =>
    request(
      '/api/tickets',
      'POST',
      { title: 'Only once', queue: 'inbox' },
      { 'Idempotency-Key': key },
    );
  const responses = await Promise.all([create(), create()]);
  const ids = responses.map((r) => JSON.parse(r.text).id);
  assert.equal(ids[0], ids[1]);
  assert.equal(
    (
      await request(
        '/api/tickets',
        'POST',
        { title: 'Changed' },
        { 'Idempotency-Key': key },
      )
    ).status,
    400,
  );
  const fileKey = randomUUID(),
    path = `/api/tickets/${ids[0]}/attachments`;
  const upload = () =>
    request(path, 'POST', Buffer.from('receipt bytes'), {
      'Content-Type': 'text/plain',
      'X-Filename': encodeURIComponent('réçu.txt'),
      'Idempotency-Key': fileKey,
    });
  const first = await upload(),
    repeated = await upload();
  assert.equal(first.status, 201);
  assert.equal(JSON.parse(first.text).id, JSON.parse(repeated.text).id);
  const task = JSON.parse((await request(`/api/tickets/${ids[0]}`)).text);
  assert.equal(task.attachments.length, 1);
  const downloaded = await request(
    `/api/attachments/${task.attachments[0].id}`,
  );
  assert.equal(downloaded.text, 'receipt bytes');
  assert.match(
    downloaded.headers.get('content-disposition'),
    /filename\*=UTF-8/,
  );
});

test('new planning records and attachment bytes survive reopen and backup restoration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-persistence-'));
  let db, restored;
  try {
    const path = join(directory, 'world.db');
    db = openDatabase(path);
    const p = projects(
      db,
      null,
      { name: 'Home', notes: 'Preserve this' },
      'POST',
    );
    const task = createTicket(db, {
      title: 'Follow up',
      project_id: p.id,
      waiting_on: 'Supplier',
      follow_up_date: civilDate(),
    });
    checklist(db, task.id, null, { title: 'Check receipt' }, 'POST');
    savedViews(
      db,
      null,
      { name: 'Waiting', filters: { waiting: 'true' } },
      'POST',
    );
    const schedule = createSchedule(db, {
      title: 'Monthly check',
      project_id: p.id,
      recurrence: { kind: 'monthly_date', day: 31 },
      checklist: ['Check first'],
    });
    const file = addAttachment(db, task.id, {
      filename: 'receipt.txt',
      contentType: 'text/plain',
      data: Buffer.from('proof'),
    });
    const before = getTicket(db, task.id);
    db.close();
    db = null;
    db = openDatabase(path);
    assert.deepEqual(getTicket(db, task.id), before);
    const backup = await runBackup(db, {
      dir: join(directory, 'backups'),
      keep: 2,
    });
    restored = openDatabase(backup.file);
    assert.deepEqual(getTicket(restored, task.id), before);
    assert.deepEqual(getSchedule(restored, schedule.id).recurrence, {
      kind: 'monthly_date',
      day: 31,
    });
    assert.equal(savedViews(restored).length, 1);
    assert.equal(projects(restored, p.id).notes, 'Preserve this');
    assert.equal(
      Buffer.from(getAttachment(restored, file.id).data).toString(),
      'proof',
    );
    assert.equal(
      restored.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
  } finally {
    restored?.close();
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('calendar routines skip downtime, preserve a single open task and separate follow-up dates', () => {
  const db = openDatabase(':memory:');
  try {
    const s = createSchedule(db, {
      title: 'First Sunday',
      next_due: '2026-01-01',
      recurrence: { kind: 'monthly_weekday', ordinal: 1, weekday: 0 },
    });
    assert.equal(s.next_due, '2026-01-04');
    const first = runSchedules(db, { today: '2026-01-04' })[0].ticket;
    updateTicket(db, first.id, {
      waiting_on: 'Technician',
      follow_up_date: '2026-02-01',
    });
    let calendar = renderCalendar(db);
    assert.match(calendar, /followup-/);
    assert.doesNotMatch(calendar, new RegExp(`UID:schedule-${s.id}@`));
    assert.equal(runSchedules(db, { today: '2026-05-01' }).length, 0);
    // Use a historical completion to make the downtime calculation independent of the test date.
    db.prepare(
      "UPDATE tickets SET status='resolved',resolved_at='2026-01-10 12:00:00' WHERE id=?",
    ).run(first.id);
    db.prepare("UPDATE schedules SET next_due='2026-02-01' WHERE id=?").run(
      s.id,
    );
    assert.equal(runSchedules(db, { today: '2026-05-01' }).length, 0);
    assert.equal(getSchedule(db, s.id).next_due, '2026-05-03');
    assert.equal(runSchedules(db, { today: '2026-05-03' }).length, 1);
  } finally {
    db.close();
  }
});

test('snoozed and waiting work is not stale; deadlines and due follow-ups remain visible', async () => {
  const db = openDatabase(':memory:');
  try {
    const a = createTicket(db, {
      title: 'Snoozed',
      snoozed_until: addDays(civilDate(), 7),
      due_date: '2000-01-01',
    });
    const b = createTicket(db, {
      title: 'Waiting',
      waiting_on: 'Delivery',
      follow_up_date: addDays(civilDate(), 7),
    });
    const c = createTicket(db, {
      title: 'Follow up now',
      waiting_on: 'Reply',
      follow_up_date: civilDate(),
    });
    db.prepare("UPDATE tickets SET updated_at='2000-01-01 00:00:00'").run();
    const stats = getStats(db);
    assert.equal(
      stats.overdue.some((t) => t.id === a.id),
      true,
    );
    assert.deepEqual(
      stats.stale.map((t) => t.id),
      [c.id],
    );
    assert.deepEqual(
      stats.follow_ups.map((t) => t.id),
      [c.id],
    );
    assert.throws(() =>
      bulkUpdateTickets(db, { ids: [a.id, b.id], project_id: 999 }),
    );
    assert.equal(getTicket(db, a.id).project_id, null);
    const sent = [],
      original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      sent.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    };
    try {
      const notifier = createNotifier({
        notify: {
          enabled: true,
          url: 'https://example.test/',
          events: new Set(['ticket.follow_up']),
          format: 'json',
          minPriority: 'low',
        },
      });
      assert.deepEqual(await notifier.sweepFollowUps(db), [c.id]);
      assert.deepEqual(await notifier.sweepFollowUps(db), []);
      updateTicket(db, c.id, { waiting_on: 'Another reply' });
      assert.deepEqual(await notifier.sweepFollowUps(db), [c.id]);
      assert.equal(sent.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    db.close();
  }
});
