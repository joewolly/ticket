import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
const password = 'startup-test-passphrase';
// Inherit OS essentials, but keep this test independent of app configuration
// and prevent it from using real credentials, webhooks, or database paths.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => /^(path|systemroot|windir|temp|tmp|home|userprofile)$/i.test(key),
));

test('the executable refuses to start without authentication configured', () => {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', serverPath], {
    env: { ...baseEnv, DB_PATH: ':memory:' },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to start/);
});

async function start(dbPath) {
  const child = spawn(process.execPath, ['--experimental-sqlite', serverPath], {
    env: {
      ...baseEnv,
      AUTH_PASSWORD: password,
      DB_PATH: dbPath,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_FORMAT: 'json',
      MAINTENANCE_INTERVAL_MINUTES: '0',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stderr.on('data', (data) => { output += data; });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };

  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Server did not start: ${output}`));
      }, 10_000);
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const entry = JSON.parse(line);
          if (entry.message === 'listening') {
            clearTimeout(timeout);
            resolve(entry.url);
          }
        }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited before startup (${code}): ${output}`));
      });
    });
    return { base, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('the executable serves authenticated requests and preserves tickets across restart', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'homelab startup '));
  let app;
  try {
    const dbPath = join(scratch, 'tickets.db');
    app = await start(dbPath);
    assert.equal((await fetch(`${app.base}/api/tickets`)).status, 401);

    const login = async () => {
      const response = await fetch(`${app.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const cookie = await login();
    const created = await fetch(`${app.base}/api/tickets`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Survives executable restart', priority: 'high', queue: 'inbox' }),
    });
    assert.equal(created.status, 201);
    const ticket = await created.json();
    const attachment = await fetch(`${app.base}/api/tickets/${ticket.id}/attachments`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'text/plain', 'X-Filename': 'restart.txt' },
      body: 'Attachment survives executable restart',
    });
    assert.equal(attachment.status, 201);
    const attachmentId = (await attachment.json()).id;
    const exported = await fetch(`${app.base}/api/export?entity=tickets&format=csv`, {
      headers: { Cookie: cookie },
    });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /Survives executable restart/);
    const metrics = await fetch(`${app.base}/api/metrics`, { headers: { Cookie: cookie } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /homelab_tickets_open\{priority="high"\} 1/);

    await app.stop();
    app = await start(dbPath);
    const restored = await fetch(`${app.base}/api/tickets/${ticket.id}`, {
      headers: { Cookie: await login() },
    });
    assert.equal(restored.status, 200);
    const restoredTask = await restored.json();
    assert.equal(restoredTask.title, ticket.title);
    assert.equal(restoredTask.queue, 'inbox');
    const download = await fetch(`${app.base}/api/attachments/${attachmentId}`, { headers: { Cookie: await login() } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'Attachment survives executable restart');
  } finally {
    if (app) await app.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
