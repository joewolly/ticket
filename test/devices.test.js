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

/* ---- Lifecycle fields ---------------------------------------------------- */

test('stores serial, purchase, warranty, and rounded cost', () => {
  const db = fresh();
  const device = createDevice(db, {
    name: 'nas-01',
    serial_number: 'SN-42',
    purchase_date: '2024-03-01',
    warranty_expires: '2027-03-01',
    cost: '899.999',
  });

  assert.equal(device.serial_number, 'SN-42');
  assert.equal(device.purchase_date, '2024-03-01');
  assert.equal(device.warranty_expires, '2027-03-01');
  assert.equal(device.cost, 900, 'cost is rounded to cents');
});

test('rejects a malformed date or a negative cost', () => {
  const db = fresh();
  assert.throws(() => createDevice(db, { name: 'x', warranty_expires: 'soon' }), { status: 400 });
  assert.throws(() => createDevice(db, { name: 'y', cost: -5 }), { status: 400 });
});

test('editing the warranty date re-arms its expiry alert', () => {
  const db = fresh();
  const device = createDevice(db, { name: 'nas-01', warranty_expires: '2027-01-01' });
  db.prepare(`UPDATE devices SET warranty_notified_at = datetime('now') WHERE id = ?`).run(device.id);

  updateDevice(db, device.id, { warranty_expires: '2028-01-01' });
  const row = db.prepare('SELECT warranty_notified_at FROM devices WHERE id = ?').get(device.id);
  assert.equal(row.warranty_notified_at, null, 'the flag clears so the new date can alert');
});

/* ---- Dependencies -------------------------------------------------------- */

test('links a device to the one it depends on and lists dependents', () => {
  const db = fresh();
  const host = createDevice(db, { name: 'pve-01', type: 'server' });
  const vm = createDevice(db, { name: 'vm-web', type: 'vm', parent_id: host.id });

  assert.equal(vm.parent_name, 'pve-01');
  assert.deepEqual(getDevice(db, host.id).dependents.map((d) => d.name), ['vm-web']);
});

test('refuses a parent that is itself, missing, or would form a loop', () => {
  const db = fresh();
  const a = createDevice(db, { name: 'a' });
  const b = createDevice(db, { name: 'b', parent_id: a.id });

  assert.throws(() => updateDevice(db, a.id, { parent_id: a.id }), { status: 400 });
  assert.throws(() => createDevice(db, { name: 'c', parent_id: 9999 }), { status: 400 });
  // a depends on b depends on a would be a cycle.
  assert.throws(() => updateDevice(db, a.id, { parent_id: b.id }), {
    status: 400,
    message: /loop/,
  });
});

test('deleting a parent orphans its dependents rather than cascading', () => {
  const db = fresh();
  const host = createDevice(db, { name: 'host' });
  const vm = createDevice(db, { name: 'vm', parent_id: host.id });

  deleteDevice(db, host.id);
  const orphan = getDevice(db, vm.id);
  assert.equal(orphan.parent_id, null);
  assert.equal(orphan.parent_name, null);
});
