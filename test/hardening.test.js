import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { resetThrottle } from '../src/auth.js';

const PASSWORD = 'correct-horse-battery';

/** Boots a throwaway server with the given config. */
async function withServer(config, run) {
  const db = openDatabase(':memory:');
  const server = createServer(db, config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = (method, path, { body, headers = {} } = {}) =>
    fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    await run({ db, request, base });
  } finally {
    server.close();
  }
}

const open = { enabled: false };
const secured = { enabled: true, password: PASSWORD, apiToken: '', cookieSecure: false, sessionDays: 30 };

beforeEach(() => resetThrottle());

/* ---- Rate limiting ------------------------------------------------------- */

test('refuses API calls past the limit and says when to retry', async () => {
  await withServer({ ...open, rateLimit: { perMinute: 5 } }, async ({ request }) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await request('GET', '/api/health')).status, 200, `request ${i}`);
    }

    const refused = await request('GET', '/api/health');
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    assert.match((await refused.json()).error, /Rate limit exceeded/);
  });
});

test('the limit applies to the API, not to page assets', async () => {
  await withServer({ ...open, rateLimit: { perMinute: 2 } }, async ({ request }) => {
    await request('GET', '/api/health');
    await request('GET', '/api/health');
    assert.equal((await request('GET', '/api/health')).status, 429);

    // A page load pulls several files; throttling those would break the app
    // before it ever became a defence.
    assert.equal((await request('GET', '/')).status, 200);
    assert.equal((await request('GET', '/app.js')).status, 200);
    assert.equal((await request('GET', '/styles.css')).status, 200);
  });
});

test('a limit of zero turns rate limiting off', async () => {
  await withServer({ ...open, rateLimit: { perMinute: 0 } }, async ({ request }) => {
    for (let i = 0; i < 50; i++) {
      assert.equal((await request('GET', '/api/health')).status, 200);
    }
  });
});

/* ---- Health endpoint ----------------------------------------------------- */

test('the health check needs authentication by default', async () => {
  await withServer(secured, async ({ request }) => {
    assert.equal((await request('GET', '/api/health')).status, 401);
  });
});

test('the health check can be opened up for orchestrators that cannot log in', async () => {
  await withServer({ ...secured, publicHealth: true }, async ({ request }) => {
    const res = await request('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });

    // Opening the health check must not open anything else.
    assert.equal((await request('GET', '/api/tickets')).status, 401);
    assert.equal((await request('GET', '/api/metrics')).status, 401);
    assert.equal((await request('GET', '/api/export')).status, 401);
  });
});

/* ---- Proxy awareness ----------------------------------------------------- */

const failLogin = (request, forwardedFor) =>
  request('POST', '/api/auth/login', {
    body: { password: 'wrong' },
    headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
  });

test('X-Forwarded-For is ignored unless a proxy is declared', async () => {
  await withServer(secured, async ({ request }) => {
    // Five failures, each claiming a different origin address.
    for (let i = 0; i < 5; i++) {
      assert.equal((await failLogin(request, `10.0.0.${i}`)).status, 401);
    }

    // Trusting the header blindly would let an attacker rotate it to keep
    // guessing forever, so the lockout must still bite.
    assert.equal((await failLogin(request, '10.0.0.99')).status, 429);
  });
});

test('behind a declared proxy, one client is locked out without taking the rest with it', async () => {
  await withServer({ ...secured, trustProxy: true }, async ({ request }) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await failLogin(request, '203.0.113.5')).status, 401);
    }
    assert.equal((await failLogin(request, '203.0.113.5')).status, 429, 'the offender is locked');

    // Without this, every request behind a reverse proxy shares the proxy's
    // address and one attacker locks out the whole household.
    assert.equal((await failLogin(request, '203.0.113.6')).status, 401, 'a bystander is not');
  });
});

test('reads only the first entry in a forwarded chain', async () => {
  await withServer({ ...secured, trustProxy: true }, async ({ request }) => {
    for (let i = 0; i < 5; i++) {
      await failLogin(request, '198.51.100.7, 10.0.0.1, 10.0.0.2');
    }
    assert.equal((await failLogin(request, '198.51.100.7')).status, 429);
  });
});

/* ---- Notification wiring ------------------------------------------------- */

test('a webhook failure does not fail the request that triggered it', async () => {
  const original = globalThis.fetch;
  const config = {
    ...open,
    notify: {
      enabled: true,
      url: 'https://hooks.invalid/nope',
      format: 'json',
      events: new Set(['ticket.created']),
      minPriority: 'low',
      timeoutMs: 500,
    },
  };

  await withServer(config, async ({ base }) => {
    // Only the webhook call is stubbed out; the request under test still goes
    // over a real socket.
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://hooks.invalid')) throw new Error('ECONNREFUSED');
      return original(url, init);
    };

    try {
      const res = await original(`${base}/api/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Notifies on create', priority: 'critical' }),
      });
      assert.equal(res.status, 201);
    } finally {
      globalThis.fetch = original;
    }
  });
});
