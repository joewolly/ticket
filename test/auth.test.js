import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  loadAuthConfig,
  createSession,
  sessionIsValid,
  destroySession,
  destroyAllSessions,
  purgeExpiredSessions,
  parseCookies,
  sessionCookie,
  resetThrottle,
} from '../src/auth.js';

const PASSWORD = 'correct-horse-battery';
const API_TOKEN = 'a-very-long-api-token-value';

/** Boots a throwaway server with the given auth config and returns helpers. */
async function withServer(config, run) {
  const db = openDatabase(':memory:');
  const server = createServer(db, config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = (method, path, { body, headers = {}, redirect = 'manual' } = {}) =>
    fetch(`${base}${path}`, {
      method,
      redirect,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** Logs in and returns the Cookie header value for subsequent requests. */
  const signIn = async (password = PASSWORD) => {
    const res = await request('POST', '/api/auth/login', { body: { password } });
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { res, cookie: setCookie.split(';')[0] };
  };

  try {
    await run({ db, request, signIn, base });
  } finally {
    server.close();
  }
}

const enabled = { enabled: true, password: PASSWORD, apiToken: '', cookieSecure: false, sessionDays: 30 };
const withToken = { ...enabled, apiToken: API_TOKEN };

beforeEach(() => resetThrottle());

/* ---- Configuration ------------------------------------------------------ */

test('refuses to start with no password and no explicit opt-out', () => {
  assert.throws(() => loadAuthConfig({}), /AUTH_PASSWORD is not set/);
});

test('rejects a password that is too short', () => {
  assert.throws(() => loadAuthConfig({ AUTH_PASSWORD: 'short' }), /at least 8 characters/);
});

test('rejects setting both a password and the opt-out', () => {
  assert.throws(
    () => loadAuthConfig({ AUTH_PASSWORD: PASSWORD, AUTH_DISABLED: 'true' }),
    /not both/,
  );
});

test('allows a deliberate opt-out', () => {
  const config = loadAuthConfig({ AUTH_DISABLED: 'true' });
  assert.equal(config.enabled, false);
});

test('accepts a valid password and optional API token', () => {
  const config = loadAuthConfig({ AUTH_PASSWORD: PASSWORD, API_TOKEN: API_TOKEN });
  assert.equal(config.enabled, true);
  assert.equal(config.apiToken, API_TOKEN);
  assert.equal(config.cookieSecure, false);
});

test('rejects a short API token', () => {
  assert.throws(
    () => loadAuthConfig({ AUTH_PASSWORD: PASSWORD, API_TOKEN: 'tiny' }),
    /at least 16 characters/,
  );
});

test('honours COOKIE_SECURE and SESSION_DAYS', () => {
  const config = loadAuthConfig({
    AUTH_PASSWORD: PASSWORD,
    COOKIE_SECURE: 'true',
    SESSION_DAYS: '7',
  });
  assert.equal(config.cookieSecure, true);
  assert.equal(config.sessionDays, 7);
});

/* ---- Session store ------------------------------------------------------ */

test('creates, validates, and destroys a session', () => {
  const db = openDatabase(':memory:');
  const { token } = createSession(db, enabled, 'test-agent');

  assert.ok(token);
  assert.equal(sessionIsValid(db, token), true);

  destroySession(db, token);
  assert.equal(sessionIsValid(db, token), false);
});

test('stores only the hash of a session token', () => {
  const db = openDatabase(':memory:');
  const { token } = createSession(db, enabled);

  const stored = db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  assert.notEqual(stored, token, 'raw token must not be stored');
  assert.match(stored, /^[a-f0-9]{64}$/);
});

test('rejects an expired session and purges it', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '-1 day'))`,
  ).run('deadbeef');

  assert.equal(sessionIsValid(db, 'anything'), false);
  purgeExpiredSessions(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('rejects empty and unknown tokens', () => {
  const db = openDatabase(':memory:');
  createSession(db, enabled);
  assert.equal(sessionIsValid(db, ''), false);
  assert.equal(sessionIsValid(db, undefined), false);
  assert.equal(sessionIsValid(db, 'not-a-real-token'), false);
});

test('signing out everywhere drops every session', () => {
  const db = openDatabase(':memory:');
  const a = createSession(db, enabled).token;
  const b = createSession(db, enabled).token;

  destroyAllSessions(db);
  assert.equal(sessionIsValid(db, a), false);
  assert.equal(sessionIsValid(db, b), false);
});

test('cookie expiry is treated as UTC, not local time', () => {
  const cookie = sessionCookie('tok', enabled, '2030-01-02 03:04:05');
  assert.match(cookie, /Expires=Wed, 02 Jan 2030 03:04:05 GMT/);
});

test('parses cookie headers, including extra whitespace', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('homelab_session=abc%3Dd'), { homelab_session: 'abc=d' });
});

/* ---- HTTP: gate --------------------------------------------------------- */

test('blocks the API without a session', async () => {
  await withServer(enabled, async ({ request }) => {
    for (const [method, path] of [
      ['GET', '/api/tickets'],
      ['GET', '/api/devices'],
      ['GET', '/api/stats'],
      ['POST', '/api/tickets'],
      ['GET', '/api/health'],
    ]) {
      const res = await request(method, path, { body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
    }
  });
});

test('redirects unauthenticated page requests to the login page', async () => {
  await withServer(enabled, async ({ request }) => {
    const res = await request('GET', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });
});

test('serves static capture assets anonymously but protects all server task data', async () => {
  await withServer(enabled, async ({ request }) => {
    for (const path of ['/app.js', '/capture.html', '/planning.js', '/capture.js', '/draft-store.js', '/sw.js', '/manifest.webmanifest', '/apple-touch-icon.png']) {
      assert.equal((await request('GET', path)).status, 200, path);
    }
    for (const path of ['/api/tickets', '/api/projects', '/api/views', '/api/planning']) {
      assert.equal((await request('GET', path)).status, 401, path);
    }
  });
});

test('serves the login page and its assets anonymously', async () => {
  await withServer(enabled, async ({ request }) => {
    const page = await request('GET', '/login');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /login-form/);

    assert.equal((await request('GET', '/login.js')).status, 200);
    assert.equal((await request('GET', '/styles.css')).status, 200);
  });
});

/* ---- HTTP: login -------------------------------------------------------- */

test('rejects a wrong password and issues no cookie', async () => {
  await withServer(enabled, async ({ signIn }) => {
    const { res, cookie } = await signIn('wrong-password-entirely');
    assert.equal(res.status, 401);
    assert.equal(cookie, '');
  });
});

test('rejects an empty or missing password', async () => {
  await withServer(enabled, async ({ request }) => {
    assert.equal((await request('POST', '/api/auth/login', { body: {} })).status, 401);
    assert.equal(
      (await request('POST', '/api/auth/login', { body: { password: '' } })).status,
      401,
    );
  });
});

test('a correct password issues a hardened session cookie', async () => {
  await withServer(enabled, async ({ signIn }) => {
    const { res } = await signIn();
    assert.equal(res.status, 200);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^homelab_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Secure/, 'Secure is opt-in for plain-HTTP LAN use');
  });
});

test('sets the Secure attribute when COOKIE_SECURE is on', async () => {
  await withServer({ ...enabled, cookieSecure: true }, async ({ signIn }) => {
    const { res } = await signIn();
    assert.match(res.headers.get('set-cookie'), /Secure/);
  });
});

test('a session cookie unlocks the API and the app', async () => {
  await withServer(enabled, async ({ request, signIn }) => {
    const { cookie } = await signIn();

    const tickets = await request('GET', '/api/tickets', { headers: { Cookie: cookie } });
    assert.equal(tickets.status, 200);

    const app = await request('GET', '/', { headers: { Cookie: cookie } });
    assert.equal(app.status, 200);
  });
});

test('an authenticated visitor is redirected away from the login page', async () => {
  await withServer(enabled, async ({ request, signIn }) => {
    const { cookie } = await signIn();
    const res = await request('GET', '/login', { headers: { Cookie: cookie } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });
});

test('a forged cookie does not grant access', async () => {
  await withServer(enabled, async ({ request }) => {
    const res = await request('GET', '/api/tickets', {
      headers: { Cookie: 'homelab_session=made-up-token' },
    });
    assert.equal(res.status, 401);
  });
});

test('logout invalidates the session it was issued for', async () => {
  await withServer(enabled, async ({ request, signIn }) => {
    const { cookie } = await signIn();

    const out = await request('POST', '/api/auth/logout', { headers: { Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /homelab_session=;/);

    const after = await request('GET', '/api/tickets', { headers: { Cookie: cookie } });
    assert.equal(after.status, 401, 'the old cookie must stop working');
  });
});

test('logout everywhere invalidates other sessions too', async () => {
  await withServer(enabled, async ({ request, signIn }) => {
    const first = await signIn();
    const second = await signIn();

    await request('POST', '/api/auth/logout', {
      headers: { Cookie: second.cookie },
      body: { everywhere: true },
    });

    const res = await request('GET', '/api/tickets', { headers: { Cookie: first.cookie } });
    assert.equal(res.status, 401);
  });
});

/* ---- HTTP: API token ---------------------------------------------------- */

test('an API token authenticates headless callers', async () => {
  await withServer(withToken, async ({ request }) => {
    const bearer = await request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    assert.equal(bearer.status, 200);

    const apiKey = await request('GET', '/api/tickets', { headers: { 'X-API-Key': API_TOKEN } });
    assert.equal(apiKey.status, 200);
  });
});

test('an API token can file a ticket, the documented script workflow', async () => {
  await withServer(withToken, async ({ request }) => {
    const res = await request('POST', '/api/tickets', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      body: { title: 'Backup job failed', priority: 'high' },
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).title, 'Backup job failed');
  });
});

test('a wrong API token is refused', async () => {
  await withServer(withToken, async ({ request }) => {
    const res = await request('GET', '/api/tickets', {
      headers: { Authorization: 'Bearer not-the-right-token-at-all' },
    });
    assert.equal(res.status, 401);
  });
});

test('API tokens do not work unless one is configured', async () => {
  await withServer(enabled, async ({ request }) => {
    const res = await request('GET', '/api/tickets', { headers: { Authorization: 'Bearer ' } });
    assert.equal(res.status, 401);
  });
});

/* ---- HTTP: throttling --------------------------------------------------- */

test('locks out after repeated failures and stays locked for the right password', async () => {
  await withServer(enabled, async ({ signIn }) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { res } = await signIn('wrong-password-entirely');
      assert.equal(res.status, 401, `attempt ${attempt + 1} should be rejected`);
    }

    const locked = await signIn('wrong-password-entirely');
    assert.equal(locked.res.status, 429);
    assert.match((await locked.res.json()).error, /Too many attempts/);

    // The lockout must not be bypassable by then supplying the real password.
    const correct = await signIn();
    assert.equal(correct.res.status, 429);
  });
});

test('a successful login clears the failure count', async () => {
  await withServer(enabled, async ({ signIn }) => {
    await signIn('wrong-password-entirely');
    await signIn('wrong-password-entirely');

    assert.equal((await signIn()).res.status, 200);

    // Having reset, there is a full budget of attempts again.
    for (let attempt = 0; attempt < 4; attempt++) {
      assert.equal((await signIn('wrong-password-entirely')).res.status, 401);
    }
  });
});

/* ---- Disabled mode ------------------------------------------------------ */

test('with auth disabled everything is reachable', async () => {
  await withServer({ enabled: false, apiToken: '', cookieSecure: false, sessionDays: 0 },
    async ({ request }) => {
      assert.equal((await request('GET', '/api/tickets')).status, 200);
      assert.equal((await request('GET', '/')).status, 200);
      // The login page is pointless without auth, so it redirects home.
      assert.equal((await request('GET', '/login')).status, 302);
    });
});
