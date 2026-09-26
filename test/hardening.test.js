import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
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

test('the calendar feed accepts the API token in the query, but only there', async () => {
  const withToken = { ...secured, apiToken: 'a-sixteen-char-tok' };
  await withServer(withToken, async ({ request }) => {
    // No credentials: refused like any other API path.
    assert.equal((await request('GET', '/api/calendar.ics')).status, 401);
    // Wrong token: still refused.
    assert.equal((await request('GET', '/api/calendar.ics?token=nope')).status, 401);
    // Correct token in the query: allowed, because a calendar app has no cookie.
    const ok = await request('GET', '/api/calendar.ics?token=a-sixteen-char-tok');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/calendar/);
    // The query-token door is scoped to the calendar alone.
    assert.equal((await request('GET', '/api/tickets?token=a-sixteen-char-tok')).status, 401);
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

test('reads the entry the proxy appended, not the ones the client sent', async () => {
  await withServer({ ...secured, trustProxy: true }, async ({ request }) => {
    // The proxy appends the real peer (198.51.100.7) after whatever the client
    // claimed. Rotating the claimed part must not buy fresh attempts.
    for (let i = 0; i < 5; i++) {
      assert.equal((await failLogin(request, `10.9.9.${i}, 198.51.100.7`)).status, 401);
    }
    assert.equal((await failLogin(request, '10.9.9.99, 198.51.100.7')).status, 429);
    assert.equal((await failLogin(request, '198.51.100.7')).status, 429);
  });
});

/* ---- Malformed requests -------------------------------------------------- */

/**
 * Sends a hand-written request over a raw socket — fetch refuses to set Host or
 * send some of the malformed input these tests need — and resolves with the
 * status code, or null if no response arrived. The timeout matters: when a
 * request crashes the handler, the connection is left open rather than closed,
 * and without it a regression would hang the suite instead of failing it.
 */
function rawRequest(base, headers) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    // write, not end: a half-closed socket makes Node abandon a response that
    // is still streaming. Connection: close has the server hang up instead.
    const socket = connect(Number(port), '127.0.0.1', () =>
      socket.write(`${headers}\r\nConnection: close\r\n\r\n`),
    );
    let reply = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1]) || null));
  });
}

test('a malformed cookie is refused, not fatal', async () => {
  await withServer(secured, async ({ request, base }) => {
    const status = await rawRequest(
      base,
      'GET /api/tickets HTTP/1.1\r\nHost: localhost\r\nCookie: homelab_session=%',
    );
    assert.equal(status, 401);
    // The server is still up and still enforcing the gate.
    assert.equal((await request('GET', '/api/tickets')).status, 401);
  });
});

test('a malformed Host header is served, not fatal', async () => {
  await withServer(secured, async ({ request, base }) => {
    const status = await rawRequest(base, 'GET /login HTTP/1.1\r\nHost: a b');
    assert.equal(status, 200);
    assert.equal((await request('GET', '/login')).status, 200);
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
