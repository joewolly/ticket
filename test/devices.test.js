import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
} from '../src/api/devices.js';
import { createTicket } from '../src/api/tickets.js';

const fresh = () => openDatabase(':memory:');

test('creates a device with defaults applied', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01' });

  assert.equal(device.name, 'nas-01');
  assert.equal(device.type, 'other');
  assert.equal(device.status, 'active');
  assert.equal(device.hostname, null);
  assert.equal(device.open_tickets, 0);
});

test('rejects a duplicate device name with a readable message', () => {
  const db = fresh();
  createDevice(db, { name: 'nas-01' });

  assert.throws(() => createDevice(db, { name: 'nas-01' }), {
    status: 400,
    message: /already exists/,
  });
});

test('rejects a blank name and an unknown type', () => {
  const db = fresh();
  assert.throws(() => createDevice(db, { name: '   ' }), { status: 400 });
  assert.throws(() => createDevice(db, { name: 'x', type: 'toaster' }), { status: 400 });
});

test('a partial update leaves untouched columns alone', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'pve-01', type: 'server', location: 'rack' });

  const updated = updateDevice(db, device.id, { location: 'closet' });

  assert.equal(updated.location, 'closet');
  assert.equal(updated.type, 'server', 'type should survive a partial update');
  assert.equal(updated.name, 'pve-01');
});

test('counts only unresolved tickets as open', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01' });

  createTicket(db, { title: 'disk noise', device_id: device.id });
  createTicket(db, { title: 'slow scrub', device_id: device.id, status: 'in_progress' });
  createTicket(db, { title: 'old fix', device_id: device.id, status: 'resolved' });

  assert.equal(getDevice(db, device.id).open_tickets, 2);
});

test('deleting a device keeps its tickets and unlinks them', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'old-box' });
  createTicket(db, { title: 'ram fault', device_id: device.id });

  deleteDevice(db, device.id);

  assert.throws(() => getDevice(db, device.id), { status: 404 });
  const remaining = db.prepare('SELECT * FROM tickets').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].device_id, null);
});

test('filters by status, type, and free-text search', () => {
  const db = fresh();
  createDevice(db, { name: 'nas-01', type: 'nas', ip_address: '10.0.0.20' });
  createDevice(db, { name: 'sw-01', type: 'network', status: 'spare', location: 'basement' });

  assert.deepEqual(listDevices(db, { type: 'nas' }).map((d) => d.name), ['nas-01']);
  assert.deepEqual(listDevices(db, { status: 'spare' }).map((d) => d.name), ['sw-01']);
  assert.deepEqual(listDevices(db, { q: '10.0.0' }).map((d) => d.name), ['nas-01']);
  assert.deepEqual(listDevices(db, { q: 'basement' }).map((d) => d.name), ['sw-01']);
  assert.equal(listDevices(db, { q: 'nothing' }).length, 0);
});

test('lists devices with the most open tickets first', () => {
  const db = fresh();
  const quiet = createDevice(db, { name: 'aaa-quiet' });
  const busy = createDevice(db, { name: 'zzz-busy' });
  createTicket(db, { title: 'a', device_id: busy.id });

  assert.deepEqual(listDevices(db).map((d) => d.id), [busy.id, quiet.id]);
});

test('404s on a missing device', () => {
  const db = fresh();
  assert.throws(() => getDevice(db, 999), { status: 404 });
  assert.throws(() => updateDevice(db, 999, { name: 'x' }), { status: 404 });
});
