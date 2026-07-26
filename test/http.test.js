import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';

let server;
let base;

before(async () => {
  server = createServer(openDatabase(':memory:'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function request(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('health check responds', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('full ticket lifecycle over HTTP', async () => {
  const device = await request('POST', '/api/devices', { name: 'pve-01', type: 'server' });
  assert.equal(device.status, 201);

  const created = await request('POST', '/api/tickets', {
    title: 'VM will not boot',
    body: 'stuck at grub',
    priority: 'high',
    device_id: device.body.id,
    tags: ['boot'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.device_name, 'pve-01');
  assert.deepEqual(created.body.tags, ['boot']);

  const id = created.body.id;

  const comment = await request('POST', `/api/tickets/${id}/comments`, { body: 'reinstalled grub' });
  assert.equal(comment.status, 201);

  const resolved = await request('PATCH', `/api/tickets/${id}`, { status: 'resolved' });
  assert.equal(resolved.status, 200);
  assert.ok(resolved.body.resolved_at);
  assert.equal(resolved.body.comments.length, 1);

  // Resolved tickets drop out of the default list but stay reachable.
  const active = await request('GET', '/api/tickets');
  assert.equal(active.body.length, 0);
  const all = await request('GET', '/api/tickets?status=all');
  assert.equal(all.body.length, 1);

  const deleted = await request('DELETE', `/api/tickets/${id}`);
  assert.equal(deleted.status, 204);
  assert.equal((await request('GET', `/api/tickets/${id}`)).status, 404);
});

test('maps validation and lookup errors to 400 and 404', async () => {
  assert.equal((await request('POST', '/api/tickets', { title: '' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { title: 'x', priority: 'nope' })).status, 400);
  assert.equal((await request('GET', '/api/tickets/99999')).status, 404);
  assert.equal((await request('GET', '/api/devices/99999')).status, 404);
});

test('distinguishes unknown routes from wrong methods', async () => {
  assert.equal((await request('GET', '/api/nope')).status, 404);
  assert.equal((await request('DELETE', '/api/health')).status, 405);
});

test('rejects a malformed JSON body', async () => {
  const res = await fetch(`${base}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('serves the app shell and rejects path traversal', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  // A client-side route with no matching file still gets the shell.
  assert.equal((await fetch(`${base}/tickets`)).status, 200);

  const escaped = await fetch(`${base}/../package.json`);
  assert.notEqual(escaped.status, 200);
});
