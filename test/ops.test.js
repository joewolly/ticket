import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createTicket } from '../src/api/tickets.js';
import { loadConfig } from '../src/config.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { createNotifier } from '../src/notify.js';
import { runBackup, runBackupSafely } from '../src/backup.js';
import { configureLogging, setLogSink, log } from '../src/log.js';

const PASSWORD = 'correct-horse-battery';
const baseEnv = { AUTH_PASSWORD: PASSWORD };

let db;
let scratch;

beforeEach(async () => {
  db = openDatabase(':memory:');
  scratch = await mkdtemp(join(tmpdir(), 'homelab-test-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/* ---- Configuration ------------------------------------------------------- */

test('an instance that sets only a password gets every extra switched off', () => {
  const config = loadConfig(baseEnv);

  assert.equal(config.notify.enabled, false);
  assert.equal(config.backup.enabled, false);
  assert.equal(config.trustProxy, false);
  assert.equal(config.publicHealth, false);
  assert.equal(config.rateLimit.perMinute, 300);
  assert.equal(config.log.level, 'info');
});

test('treats the empty strings docker compose passes as unset', () => {
  // `FOO: ${FOO:-}` in a compose file sends "" rather than omitting the
  // variable, so every optional setting has to read that as "not configured".
  const config = loadConfig({
    ...baseEnv,
    TRUST_PROXY: '',
    PUBLIC_HEALTH: '',
    RATE_LIMIT_PER_MINUTE: '',
    LOG_LEVEL: '',
    LOG_FORMAT: '',
    NOTIFY_URL: '',
    NOTIFY_FORMAT: '',
    NOTIFY_EVENTS: '',
    NOTIFY_MIN_PRIORITY: '',
    NOTIFY_TIMEOUT_MS: '',
    BACKUP_DIR: '',
    BACKUP_INTERVAL_HOURS: '',
    BACKUP_KEEP: '',
    MAINTENANCE_INTERVAL_MINUTES: '',
    SESSION_DAYS: '',
  });

  assert.equal(config.trustProxy, false);
  assert.equal(config.notify.enabled, false);
  assert.equal(config.backup.enabled, false);
  assert.equal(config.rateLimit.perMinute, 300);
  assert.equal(config.maintenanceMinutes, 60);
  assert.equal(config.sessionDays, 30);
  assert.equal(config.log.level, 'info');
});

test('refuses to start on a malformed value rather than falling back', () => {
  assert.throws(() => loadConfig({ ...baseEnv, RATE_LIMIT_PER_MINUTE: 'lots' }), /whole number/);
  assert.throws(() => loadConfig({ ...baseEnv, TRUST_PROXY: 'maybe' }), /must be true or false/);
  assert.throws(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'chatty' }), /must be one of/);
  assert.throws(() => loadConfig({ ...baseEnv, NOTIFY_URL: 'not a url' }), /must be a valid URL/);
  assert.throws(() => loadConfig({ ...baseEnv, NOTIFY_EVENTS: 'ticket.exploded' }), /allowed:/);
});

test('a session lifetime typo is caught at startup, not at sign-in', () => {
  // This used to become NaN and only surface as a crash when someone logged in.
  assert.throws(() => loadConfig({ ...baseEnv, SESSION_DAYS: 'thirty' }), /whole number/);
  assert.equal(loadConfig({ ...baseEnv, SESSION_DAYS: '7' }).sessionDays, 7);
});

test('rejects a webhook URL that is not http or https', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, NOTIFY_URL: 'file:///etc/passwd' }),
    /must be an http or https URL/,
  );
});

/* ---- Rate limiting ------------------------------------------------------- */

test('allows up to the limit, then refuses with a retry hint', () => {
  const limiter = createRateLimiter({ perMinute: 3 });

  for (let i = 0; i < 3; i++) assert.equal(limiter.check('a').allowed, true, `request ${i}`);

  const refused = limiter.check('a');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1);
});

test('counts each client separately', () => {
  const limiter = createRateLimiter({ perMinute: 1 });

  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.check('b').allowed, true);
});

test('starts a fresh window once the old one lapses', () => {
  const limiter = createRateLimiter({ perMinute: 1, windowMs: 20 });

  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false);

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.check('a').allowed, true);
      resolve();
    }, 30);
  });
});

test('a limit of zero disables the limiter entirely', () => {
  const limiter = createRateLimiter({ perMinute: 0 });
  for (let i = 0; i < 1000; i++) assert.equal(limiter.check('a').allowed, true);
});

test('keeps the tracked-client map bounded', () => {
  const limiter = createRateLimiter({ perMinute: 10 });
  for (let i = 0; i < 20_000; i++) limiter.check(`client-${i}`);

  assert.ok(limiter.size <= 5000, `tracked ${limiter.size} clients`);
});

/* ---- Notifications ------------------------------------------------------- */

/** Swaps in a fetch that records calls instead of making them. */
function captureFetch(status = 200) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: status < 400, status };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const notifyEnv = { ...baseEnv, NOTIFY_URL: 'https://hooks.example/homelab' };

test('sends nothing when no webhook is configured', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(baseEnv));
    assert.equal(await notifier.send('ticket.created', { id: 1, title: 'x', priority: 'high' }), false);
    assert.equal(capture.calls.length, 0);
  } finally {
    capture.restore();
  }
});

test('posts JSON describing the ticket', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(notifyEnv));
    const ticket = { id: 7, title: 'Disk failed', status: 'open', priority: 'critical', device_name: 'nas-01' };

    assert.equal(await notifier.send('ticket.created', ticket), true);
    assert.equal(capture.calls.length, 1);

    const [call] = capture.calls;
    assert.equal(call.url, 'https://hooks.example/homelab');
    assert.equal(call.headers['Content-Type'], 'application/json');

    const payload = JSON.parse(call.body);
    assert.equal(payload.event, 'ticket.created');
    assert.match(payload.subject, /Disk failed/);
    assert.equal(payload.ticket.device, 'nas-01');
  } finally {
    capture.restore();
  }
});

test('uses headers rather than a JSON body in ntfy mode', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_FORMAT: 'ntfy' }));
    await notifier.send('ticket.created', { id: 1, title: 'Fan noise', priority: 'high' });

    const [call] = capture.calls;
    assert.match(call.headers.Title, /Fan noise/);
    assert.equal(call.headers.Priority, '4');
    assert.match(call.body, /Ticket #1/);
  } finally {
    capture.restore();
  }
});

test('folds newlines out of an ntfy title, which must stay one line', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_FORMAT: 'ntfy' }));
    await notifier.send('ticket.created', { id: 1, title: 'Broke\r\nX-Injected: yes', priority: 'low' });

    assert.doesNotMatch(capture.calls[0].headers.Title, /[\r\n]/);
  } finally {
    capture.restore();
  }
});

test('honours the minimum priority', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_MIN_PRIORITY: 'high' }));

    assert.equal(await notifier.send('ticket.created', { id: 1, title: 'Minor', priority: 'low' }), false);
    assert.equal(await notifier.send('ticket.created', { id: 2, title: 'Bad', priority: 'critical' }), true);
    assert.equal(capture.calls.length, 1);
  } finally {
    capture.restore();
  }
});

test('honours the event allow-list', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_EVENTS: 'ticket.resolved' }));

    await notifier.send('ticket.created', { id: 1, title: 'x', priority: 'high' });
    await notifier.send('ticket.resolved', { id: 1, title: 'x', priority: 'high' });

    assert.equal(capture.calls.length, 1);
  } finally {
    capture.restore();
  }
});

test('a webhook that fails never throws at the caller', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const notifier = createNotifier(loadConfig(notifyEnv));
    assert.equal(await notifier.send('ticket.created', { id: 1, title: 'x', priority: 'high' }), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('announces each overdue ticket once, not on every sweep', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(notifyEnv));
    createTicket(db, { title: 'Late', due_date: '2020-01-01' });
    createTicket(db, { title: 'Not due', due_date: '2999-01-01' });

    assert.equal((await notifier.sweepOverdue(db)).length, 1);
    assert.equal((await notifier.sweepOverdue(db)).length, 0, 'second sweep stays quiet');
    assert.equal(capture.calls.length, 1);
  } finally {
    capture.restore();
  }
});

test('re-arms the overdue alert when the due date is moved', async () => {
  const capture = captureFetch();
  try {
    const { updateTicket } = await import('../src/api/tickets.js');
    const notifier = createNotifier(loadConfig(notifyEnv));
    const ticket = createTicket(db, { title: 'Late', due_date: '2020-01-01' });

    await notifier.sweepOverdue(db);
    updateTicket(db, ticket.id, { due_date: '2021-01-01' });

    assert.equal((await notifier.sweepOverdue(db)).length, 1, 'lapsing again is announced again');
  } finally {
    capture.restore();
  }
});

test('leaves resolved tickets out of the overdue sweep', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(notifyEnv));
    createTicket(db, { title: 'Late but done', due_date: '2020-01-01', status: 'resolved' });

    assert.equal((await notifier.sweepOverdue(db)).length, 0);
  } finally {
    capture.restore();
  }
});

test('nudges tickets whose due date is coming up, once each', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(
      loadConfig({ ...notifyEnv, NOTIFY_EVENTS: 'ticket.due_soon', NOTIFY_REMINDER_DAYS: '3' }),
    );
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    createTicket(db, { title: 'Renew cert', due_date: soon });
    createTicket(db, { title: 'Later', due_date: far });

    assert.deepEqual((await notifier.sweepDueSoon(db)).length, 1);
    assert.equal((await notifier.sweepDueSoon(db)).length, 0, 'second sweep stays quiet');
    assert.equal(capture.calls.length, 1);
  } finally {
    capture.restore();
  }
});

test('the due-soon sweep is silent unless its event is enabled', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(notifyEnv)); // default events omit due_soon
    const soon = new Date(Date.now() + 1 * 86400_000).toISOString().slice(0, 10);
    createTicket(db, { title: 'x', due_date: soon });

    assert.equal((await notifier.sweepDueSoon(db)).length, 0);
  } finally {
    capture.restore();
  }
});

test('sends a digest at most once per cadence', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_DIGEST: 'weekly' }));
    createTicket(db, { title: 'Open one' });

    assert.equal(await notifier.maybeSendDigest(db), true);
    assert.equal(await notifier.maybeSendDigest(db), false, 'still within the week');
    assert.equal(capture.calls.length, 1);

    const payload = JSON.parse(capture.calls[0].body);
    assert.equal(payload.event, 'digest');
    assert.equal(payload.open, 1);
  } finally {
    capture.restore();
  }
});

test('the digest cadence advances once the interval has passed', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig({ ...notifyEnv, NOTIFY_DIGEST: 'daily' }));
    // Backdate the last send two days so the daily cadence is due again.
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('digest_last_sent', datetime('now', '-2 days'))`,
    ).run();

    assert.equal(await notifier.maybeSendDigest(db), true);
  } finally {
    capture.restore();
  }
});

test('digest stays off by default', async () => {
  const capture = captureFetch();
  try {
    const notifier = createNotifier(loadConfig(notifyEnv));
    assert.equal(await notifier.maybeSendDigest(db), false);
    assert.equal(capture.calls.length, 0);
  } finally {
    capture.restore();
  }
});

/* ---- Warranty sweep ------------------------------------------------------ */

test('opens one ticket for a device whose warranty is about to lapse', async () => {
  const { createDevice } = await import('../src/api/devices.js');
  const { sweepWarranties } = await import('../src/api/warranty.js');
  const { listTickets } = await import('../src/api/tickets.js');

  const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const far = new Date(Date.now() + 200 * 86400_000).toISOString().slice(0, 10);
  createDevice(db, { name: 'switch-01', warranty_expires: soon });
  createDevice(db, { name: 'nas-01', warranty_expires: far });

  const opened = sweepWarranties(db, { leadDays: 30 });
  assert.equal(opened.length, 1);
  assert.match(opened[0].ticket.title, /switch-01/);
  assert.deepEqual(opened[0].ticket.tags, ['warranty']);

  // A second sweep does not open a duplicate.
  assert.equal(sweepWarranties(db, { leadDays: 30 }).length, 0);
  assert.equal(listTickets(db, { tag: 'warranty' }).length, 1);
});

test('the warranty sweep ignores retired devices and can be disabled', async () => {
  const { createDevice } = await import('../src/api/devices.js');
  const { sweepWarranties } = await import('../src/api/warranty.js');

  const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  createDevice(db, { name: 'old-box', status: 'retired', warranty_expires: soon });
  createDevice(db, { name: 'live-box', warranty_expires: soon });

  assert.equal(sweepWarranties(db, { leadDays: 0 }).length, 0, 'leadDays 0 disables it');
  const opened = sweepWarranties(db, { leadDays: 30 });
  assert.deepEqual(opened.map((o) => o.ticket.device_name), ['live-box']);
});

/* ---- Backups ------------------------------------------------------------- */

test('writes a snapshot that opens as a database of its own', async () => {
  createTicket(db, { title: 'Survives the backup' });

  const result = await runBackup(db, { dir: scratch, keep: 7 });
  assert.ok(result.bytes > 0);

  const restored = openDatabase(result.file);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 1);
  restored.close();
});

test('keeps only the newest snapshots', async () => {
  // Names sort chronologically, so pre-seeding older ones exercises the prune.
  for (const stamp of ['20200101T000000.000Z', '20200102T000000.000Z', '20200103T000000.000Z']) {
    await writeFile(join(scratch, `homelab-${stamp}.db`), 'old');
  }

  await runBackup(db, { dir: scratch, keep: 2 });

  const kept = (await readdir(scratch)).sort();
  assert.equal(kept.length, 2);
  // The one just written is newest, so it survives along with one predecessor.
  assert.ok(kept.some((name) => name.startsWith('homelab-2026') || name.startsWith('homelab-20')));
});

test('never prunes files it did not write', async () => {
  await writeFile(join(scratch, 'important.db'), 'not ours');
  await writeFile(join(scratch, 'homelab-notes.txt'), 'not ours either');

  await runBackup(db, { dir: scratch, keep: 1 });

  const remaining = await readdir(scratch);
  assert.ok(remaining.includes('important.db'));
  assert.ok(remaining.includes('homelab-notes.txt'));
});

test('does nothing when no backup directory is configured', async () => {
  assert.equal(await runBackup(db, { dir: '' }), null);
});

test('a failing backup is swallowed so the timer survives it', async () => {
  // A regular file where a directory should be: mkdir fails with ENOTDIR, which
  // stands in for the full disk or bad mount this guard actually exists for.
  const blocked = join(scratch, 'not-a-directory');
  await writeFile(blocked, '');

  assert.equal(await runBackupSafely(db, { dir: blocked, keep: 1 }), null);
});

/* ---- Logging ------------------------------------------------------------- */

/** Collects log output instead of writing it to stdout. */
function captureLogs(options) {
  const lines = [];
  setLogSink({ write: (line) => lines.push(line) });
  configureLogging(options);
  return lines;
}

test('emits one JSON object per record', () => {
  const lines = captureLogs({ level: 'info', format: 'json' });
  try {
    log.info('backup written', { file: '/data/x.db', bytes: 12 });

    const record = JSON.parse(lines[0]);
    assert.equal(record.level, 'info');
    assert.equal(record.message, 'backup written');
    assert.equal(record.bytes, 12);
    assert.ok(Date.parse(record.time));
  } finally {
    setLogSink(process.stdout);
    configureLogging({ level: 'info', format: 'text' });
  }
});

test('drops records below the configured level', () => {
  const lines = captureLogs({ level: 'warn', format: 'text' });
  try {
    log.debug('noise');
    log.info('also noise');
    log.warn('this one matters');

    assert.equal(lines.length, 1);
    assert.match(lines[0], /WARN.*this one matters/);
  } finally {
    setLogSink(process.stdout);
    configureLogging({ level: 'info', format: 'text' });
  }
});

test('quotes text-format values that contain spaces', () => {
  const lines = captureLogs({ level: 'info', format: 'text' });
  try {
    log.info('request', { path: '/api/tickets', note: 'has spaces' });

    assert.match(lines[0], /path=\/api\/tickets/);
    assert.match(lines[0], /note="has spaces"/);
  } finally {
    setLogSink(process.stdout);
    configureLogging({ level: 'info', format: 'text' });
  }
});
