import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createDevice } from '../src/api/devices.js';
import { createTicket } from '../src/api/tickets.js';
import { createSchedule } from '../src/api/schedules.js';
import { exportEntity } from '../src/api/export.js';
import { renderMetrics } from '../src/api/metrics.js';

let db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

const rows = (csv) => csv.trimEnd().split('\r\n');

/* ---- Export -------------------------------------------------------------- */

test('exports tickets as CSV with a header row', () => {
  const device = createDevice(db, { name: 'nas-01', type: 'nas' });
  createTicket(db, { title: 'Disk failed', priority: 'high', device_id: device.id, tags: ['disk'] });

  const result = exportEntity(db, { entity: 'tickets', format: 'csv' });

  assert.match(result.contentType, /text\/csv/);
  assert.match(result.filename, /^homelab-tickets-\d{4}-\d{2}-\d{2}\.csv$/);

  const [header, first] = rows(result.body);
  assert.equal(header.split(',')[0], 'id');
  assert.match(first, /Disk failed/);
  assert.match(first, /nas-01/);
});

test('quotes cells containing commas, quotes, or newlines', () => {
  createTicket(db, {
    title: 'Rebooted, then it hung',
    body: 'He said "it is fine"\nit was not',
  });

  const [, row] = rows(exportEntity(db, { entity: 'tickets', format: 'csv' }).body.trimEnd());

  assert.match(row, /"Rebooted, then it hung"/);
  // Embedded quotes are doubled per RFC 4180.
  assert.match(row, /""it is fine""/);
});

test('defuses cells that a spreadsheet would run as a formula', () => {
  createTicket(db, { title: '=cmd|calc' });
  createTicket(db, { title: '+1234' });
  createTicket(db, { title: '@SUM(A1)' });
  // A leading minus is left alone: it heads far more real values than attacks.
  createTicket(db, { title: '-12 dB of loss' });

  const body = exportEntity(db, { entity: 'tickets', format: 'csv' }).body;

  assert.match(body, /'=cmd\|calc/);
  assert.match(body, /'\+1234/);
  assert.match(body, /'@SUM\(A1\)/);
  assert.match(body, /-12 dB of loss/);
  assert.doesNotMatch(body, /'-12 dB/);
});

test('exports every ticket including closed ones, since an export is an archive', () => {
  createTicket(db, { title: 'Still open' });
  createTicket(db, { title: 'Long since done', status: 'closed' });

  assert.equal(rows(exportEntity(db, { entity: 'tickets', format: 'csv' }).body).length, 3);
});

test('narrows to a single status on request', () => {
  createTicket(db, { title: 'Still open' });
  createTicket(db, { title: 'Long since done', status: 'closed' });

  const body = exportEntity(db, { entity: 'tickets', format: 'csv', status: 'closed' }).body;
  assert.equal(rows(body).length, 2);
  assert.match(body, /Long since done/);
});

test('rejects an unknown entity, format, or status rather than guessing', () => {
  assert.throws(() => exportEntity(db, { entity: 'passwords' }), /entity must be one of/);
  assert.throws(() => exportEntity(db, { format: 'xlsx' }), /format must be one of/);
  assert.throws(
    () => exportEntity(db, { entity: 'tickets', status: "open' OR 1=1--" }),
    /status must be one of/,
  );
});

test('exports devices and schedules too', () => {
  createDevice(db, { name: 'pve-01', type: 'server', ip_address: '10.0.0.10' });
  createSchedule(db, { title: 'Replace filters', interval_days: 90 });

  assert.match(exportEntity(db, { entity: 'devices', format: 'csv' }).body, /pve-01,.*10\.0\.0\.10/);
  assert.match(
    exportEntity(db, { entity: 'schedules', format: 'csv' }).body,
    /Replace filters,medium,,,90,0/,
  );
});

test('exports JSON as an array of objects', () => {
  createTicket(db, { title: 'Something broke', priority: 'critical' });

  const result = exportEntity(db, { entity: 'tickets', format: 'json' });
  assert.match(result.contentType, /application\/json/);

  const parsed = JSON.parse(result.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Something broke');
  assert.equal(parsed[0].priority, 'critical');
});

/* ---- Metrics ------------------------------------------------------------- */

test('renders every priority and status, including the empty ones', () => {
  createTicket(db, { title: 'Urgent', priority: 'critical' });

  const body = renderMetrics(db);

  assert.match(body, /homelab_tickets_open\{priority="critical"\} 1/);
  assert.match(body, /homelab_tickets_open\{priority="low"\} 0/);
  assert.match(body, /homelab_tickets\{status="closed"\} 0/);
});

test('counts overdue tickets and due schedules', () => {
  createTicket(db, { title: 'Late', due_date: '2020-01-01' });
  createSchedule(db, { title: 'Due today', interval_days: 30 });

  const body = renderMetrics(db);

  assert.match(body, /^homelab_tickets_overdue 1$/m);
  assert.match(body, /^homelab_schedules_due 1$/m);
  assert.match(body, /^homelab_schedules_active 1$/m);
});

test('every metric is preceded by HELP and TYPE lines', () => {
  const lines = renderMetrics(db).trimEnd().split('\n');
  const names = new Set(
    lines.filter((line) => !line.startsWith('#')).map((line) => line.split(/[{ ]/)[0]),
  );

  for (const name of names) {
    assert.ok(lines.includes(`# TYPE ${name} gauge`) || lines.includes(`# TYPE ${name} counter`),
      `${name} has no TYPE line`);
    assert.ok(lines.some((line) => line.startsWith(`# HELP ${name} `)), `${name} has no HELP line`);
  }
});

test('label values stay bounded to fixed enums, never device names', () => {
  createDevice(db, { name: 'a device with "quotes" and \\slashes', type: 'other' });

  const body = renderMetrics(db);
  assert.doesNotMatch(body, /quotes/);
  assert.doesNotMatch(body, /slashes/);
});
