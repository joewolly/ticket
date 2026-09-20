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
