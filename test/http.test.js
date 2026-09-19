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

test('task queues can be captured, reviewed in bulk, searched, completed, and reopened over HTTP', async () => {
  const first = await request('POST', '/api/tickets', { title: 'queue-http first', queue: 'inbox' });
  const second = await request('POST', '/api/tickets', { title: 'queue-http second', queue: 'inbox' });
  assert.equal(first.status, 201);
  assert.equal(first.body.queue, 'inbox');
  const ids = [first.body.id, second.body.id];
  const move = await request('POST', '/api/tickets/bulk', { ids, queue: 'someday' });
  assert.equal(move.status, 200);
  assert.equal(move.body.updated, 2);
  const inbox = await request('GET', '/api/tickets?queue=inbox&q=queue-http');
  assert.equal(inbox.body.length, 0);
  await request('PATCH', `/api/tickets/${ids[0]}`, { status: 'resolved' });
  const done = await request('GET', '/api/tickets?status=done&q=queue-http');
  assert.deepEqual(done.body.map((x) => x.id), [ids[0]]);
  const all = await request('GET', '/api/tickets?status=all&q=queue-http');
  assert.equal(all.body.length, 2);
  const reopened = await request('PATCH', `/api/tickets/${ids[0]}`, { queue: 'next', status: 'open' });
  assert.equal(reopened.body.queue, 'next');
  assert.equal(reopened.body.resolved_at, null);
  assert.equal((await request('GET', '/api/tickets?queue=invalid')).status, 400);
  assert.equal((await request('PATCH', `/api/tickets/${ids[0]}`, { queue: 'invalid' })).status, 400);
  for (const id of ids) await request('DELETE', `/api/tickets/${id}`);
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

/* ---- Response headers ---------------------------------------------------- */

test('sends security headers on pages and API responses alike', async () => {
  for (const path of ['/', '/api/health']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', path);

    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
  }
});

test("the script-src directive stays strict, so no inline script may be added", async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');

  // Styles need 'unsafe-inline' for the badge colour attributes; scripts do
  // not, and that is the half of the policy worth keeping honest.
  assert.match(csp, /script-src 'self'(;|$)/);

  const appJs = await (await fetch(`${base}/app.js`)).text();
  const shell = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(shell, /<script(?![^>]*\ssrc=)/i, 'index.html has an inline script');
  assert.ok(appJs.length > 0);
});

test('keeps API responses out of caches', async () => {
  const res = await fetch(`${base}/api/tickets`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

/* ---- Links --------------------------------------------------------------- */

test('attaches and removes reference links on a ticket', async () => {
  const ticket = await request('POST', '/api/tickets', { title: 'Router keeps rebooting' });
  const id = ticket.body.id;

  const link = await request('POST', `/api/tickets/${id}/links`, {
    url: 'https://forum.example/thread/42',
    label: 'Forum thread',
  });
  assert.equal(link.status, 201);
  assert.equal(link.body.label, 'Forum thread');

  const withLink = await request('GET', `/api/tickets/${id}`);
  assert.equal(withLink.body.links.length, 1);

  assert.equal((await request('DELETE', `/api/tickets/${id}/links/${link.body.id}`)).status, 204);
  assert.equal((await request('GET', `/api/tickets/${id}`)).body.links.length, 0);
});

test('refuses a link scheme that would execute when rendered', async () => {
  const ticket = await request('POST', '/api/tickets', { title: 'Link validation' });
  const id = ticket.body.id;

  for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'not a url', '']) {
    const res = await request('POST', `/api/tickets/${id}/links`, { url });
    assert.equal(res.status, 400, `should reject ${JSON.stringify(url)}`);
  }
});

test('404s for a link that belongs to a different ticket', async () => {
  const a = await request('POST', '/api/tickets', { title: 'Ticket A' });
  const b = await request('POST', '/api/tickets', { title: 'Ticket B' });
  const link = await request('POST', `/api/tickets/${a.body.id}/links`, {
    url: 'https://example.com',
  });

  assert.equal((await request('DELETE', `/api/tickets/${b.body.id}/links/${link.body.id}`)).status, 404);
});

/* ---- Schedules ----------------------------------------------------------- */

test('drives a schedule through its whole lifecycle over HTTP', async () => {
  const created = await request('POST', '/api/schedules', {
    title: 'Blow out the dust',
    interval_days: 30,
    tags: ['maintenance'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.paused, false);
  const id = created.body.id;

  const run = await request('POST', '/api/maintenance/run');
  assert.equal(run.status, 200);
  const entry = run.body.schedules_fired.find((f) => f.schedule_id === id);
  assert.ok(entry, 'the due schedule fired');

  const ticket = await request('GET', `/api/tickets/${entry.ticket_id}`);
  assert.equal(ticket.body.title, 'Blow out the dust');
  assert.equal(ticket.body.schedule_id, id);

  const paused = await request('PATCH', `/api/schedules/${id}`, { paused: true });
  assert.equal(paused.body.paused, true);

  assert.equal((await request('DELETE', `/api/schedules/${id}`)).status, 204);
  assert.equal((await request('GET', `/api/schedules/${id}`)).status, 404);

  // The generated ticket outlives the schedule, unlinked.
  assert.equal((await request('GET', `/api/tickets/${entry.ticket_id}`)).body.schedule_id, null);
});

test('rejects an invalid schedule with a 400', async () => {
  assert.equal((await request('POST', '/api/schedules', { title: '' })).status, 400);
  assert.equal(
    (await request('POST', '/api/schedules', { title: 'x', interval_days: 0 })).status,
    400,
  );
});

/* ---- Export and metrics -------------------------------------------------- */

test('serves an export as a downloadable attachment', async () => {
  await request('POST', '/api/tickets', { title: 'Exportable' });

  const res = await fetch(`${base}/api/export?entity=tickets&format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="homelab-tickets-/);
  assert.match(await res.text(), /Exportable/);
});

test('serves metrics in Prometheus exposition format', async () => {
  const res = await fetch(`${base}/api/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
  assert.match(await res.text(), /# TYPE homelab_tickets_open gauge/);
});

test('rejects an unknown export entity with a 400, not a 500', async () => {
  const res = await fetch(`${base}/api/export?entity=sessions`);
  assert.equal(res.status, 400);
});

/* ---- Attachments --------------------------------------------------------- */

// A one-pixel PNG header is enough to exercise the binary path.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('uploads, serves, and deletes an attachment', async () => {
  const ticket = await request('POST', '/api/tickets', { title: 'Has a photo' });
  const id = ticket.body.id;

  const up = await fetch(`${base}/api/tickets/${id}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': 'drive.png' },
    body: PNG,
  });
  assert.equal(up.status, 201);
  const meta = await up.json();
  assert.equal(meta.filename, 'drive.png');
  assert.equal(meta.size, PNG.length);

  const withFile = await request('GET', `/api/tickets/${id}`);
  assert.equal(withFile.body.attachments.length, 1);

  const download = await fetch(`${base}/api/attachments/${meta.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /image\/png/);
  assert.match(download.headers.get('content-disposition'), /^inline/);
  assert.equal(Buffer.from(await download.arrayBuffer()).equals(PNG), true);

  assert.equal((await request('DELETE', `/api/tickets/${id}/attachments/${meta.id}`)).status, 204);
  assert.equal((await request('GET', `/api/tickets/${id}`)).body.attachments.length, 0);
});

for (const [filename, contentType, disposition] of [
  ['photo-café.png', 'image/png', 'inline'],
  ['照片📷.png', 'image/png', 'inline'],
  ["账单 (1)'*.pdf", 'application/pdf', 'attachment'],
  ['100% done.txt', 'text/plain', 'attachment'],
  ['quoted"name.txt', 'text/plain', 'attachment'],
  ['control\u007fname.txt', 'text/plain', 'attachment'],
]) {
  test(`round-trips attachment filename ${JSON.stringify(filename)} over HTTP`, async () => {
    const ticket = await request('POST', '/api/tickets', { title: 'Filename round trip' });
    const up = await fetch(`${base}/api/tickets/${ticket.body.id}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Filename': encodeURIComponent(filename) },
      body: PNG,
    });
    assert.equal(up.status, 201);
    const meta = await up.json();
    assert.equal(meta.filename, filename);

    const download = await fetch(`${base}/api/attachments/${meta.id}`);
    assert.equal(download.status, 200);
    const header = download.headers.get('content-disposition');
    assert.ok(header.startsWith(`${disposition}; `));
    assert.match(header, /; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]+";/);
    const encoded = /; filename\*=UTF-8''([^;]+)$/.exec(header)?.[1];
    assert.ok(encoded, 'the header includes a UTF-8 filename');
    assert.doesNotMatch(encoded, /[^A-Za-z0-9!#$&+.^_`|~%\-]/);
    assert.equal(decodeURIComponent(encoded), filename);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
  });
}

test('rejects an attachment type that a browser might execute', async () => {
  const ticket = await request('POST', '/api/tickets', { title: 'x' });
  const res = await fetch(`${base}/api/tickets/${ticket.body.id}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html', 'X-Filename': 'x.html' },
    body: Buffer.from('<script>alert(1)</script>'),
  });
  assert.equal(res.status, 400);
});

test('strips path traversal from an uploaded filename', async () => {
  const ticket = await request('POST', '/api/tickets', { title: 'x' });
  const up = await fetch(`${base}/api/tickets/${ticket.body.id}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': '../../etc/passwd' },
    body: PNG,
  });
  const meta = await up.json();
  assert.doesNotMatch(meta.filename, /[/\\]|\.\./);
});

/* ---- Bulk updates -------------------------------------------------------- */

test('closes several tickets in one request', async () => {
  const a = await request('POST', '/api/tickets', { title: 'a' });
  const b = await request('POST', '/api/tickets', { title: 'b' });

  const res = await request('POST', '/api/tickets/bulk', {
    ids: [a.body.id, b.body.id],
    status: 'closed',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  assert.ok(res.body.tickets.every((t) => t.status === 'closed'));
  assert.equal((await request('GET', `/api/tickets/${a.body.id}`)).body.status, 'closed');
});

/* ---- Calendar feed ------------------------------------------------------- */

test('serves an iCalendar feed of due dates and schedules', async () => {
  await request('POST', '/api/tickets', { title: 'Cert renewal', due_date: '2030-01-01' });
  await request('POST', '/api/schedules', { title: 'Dust blow', interval_days: 90, next_due: '2030-02-01' });

  const res = await fetch(`${base}/api/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);

  const body = await res.text();
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /SUMMARY:\[medium\] Cert renewal/);
  assert.match(body, /Dust blow/);
  assert.match(body, /DTSTART;VALUE=DATE:20300101/);
});
