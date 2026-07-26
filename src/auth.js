import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'homelab_session';

/** Paths reachable without a session — the login page and the API it posts to. */
const PUBLIC_PATHS = new Set(['/login', '/login.js', '/styles.css', '/api/auth/login']);

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_SESSION_DAYS = 30;

/** Login throttling: this many failures from one address triggers a lockout. */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? '');

/**
 * Reads auth settings from the environment, refusing to start in an unsafe
 * configuration. Running without a password requires saying so explicitly via
 * AUTH_DISABLED, so an unauthenticated instance is always a deliberate choice
 * rather than the result of a forgotten variable.
 */
export function loadAuthConfig(env = process.env) {
  const disabled = truthy(env.AUTH_DISABLED);
  const password = env.AUTH_PASSWORD ?? '';

  if (disabled) {
    if (password) {
      throw new Error('Set either AUTH_PASSWORD or AUTH_DISABLED, not both.');
    }
    return { enabled: false, apiToken: '', cookieSecure: false, sessionDays: 0 };
  }

  if (!password) {
    throw new Error(
      'AUTH_PASSWORD is not set.\n' +
        'Set a password to protect this instance:\n' +
        '  AUTH_PASSWORD=your-long-passphrase\n' +
        'Or, if it already sits behind an authenticating proxy such as Authelia\n' +
        'or Tailscale, opt out deliberately with:\n' +
        '  AUTH_DISABLED=true',
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const apiToken = env.API_TOKEN ?? '';
  if (apiToken && apiToken.length < 16) {
    throw new Error('API_TOKEN must be at least 16 characters.');
  }

  return {
    enabled: true,
    password,
    apiToken,
    cookieSecure: truthy(env.COOKIE_SECURE),
    sessionDays: Number(env.SESSION_DAYS ?? DEFAULT_SESSION_DAYS),
  };
}

/**
 * Compares two secrets without leaking their contents through timing. Hashing
 * first gives both sides a fixed width, which timingSafeEqual requires.
 */
function secretsMatch(a, b) {
  const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/* ---- Sessions ----------------------------------------------------------- */

export function createSession(db, config, userAgent) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  db.prepare(
    'INSERT INTO sessions (token_hash, expires_at, user_agent) VALUES (?, ?, ?)',
  ).run(hashToken(token), expiresAt, (userAgent ?? '').slice(0, 200) || null);

  purgeExpiredSessions(db);
  return { token, expiresAt };
}

export function sessionIsValid(db, token) {
  if (!token) return false;
  const row = db
    .prepare(`SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`)
    .get(hashToken(token));
  return Boolean(row);
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Invalidates every session — used when logging out everywhere. */
export function destroyAllSessions(db) {
  db.prepare('DELETE FROM sessions').run();
}

export function purgeExpiredSessions(db) {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

/* ---- Login throttling --------------------------------------------------- */

const failures = new Map();

/** Returns the seconds remaining on a lockout, or 0 when the caller may try. */
export function lockoutRemaining(key) {
  const entry = failures.get(key);
  if (!entry || entry.count < MAX_ATTEMPTS) return 0;

  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    failures.delete(key);
    return 0;
  }
  return Math.ceil(remaining / 1000);
}

export function recordFailure(key) {
  const entry = failures.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + LOCKOUT_MS;
  failures.set(key, entry);
}

export function clearFailures(key) {
  failures.delete(key);
}

/** Test seam — drops all throttling state. */
export function resetThrottle() {
  failures.clear();
}

/* ---- Request helpers ---------------------------------------------------- */

export function parseCookies(header = '') {
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function sessionCookie(token, config, expiresAt) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax still sends the cookie on top-level navigation (so a bookmark lands
    // logged in) while withholding it from cross-site form posts, which is the
    // CSRF vector that matters here.
    'SameSite=Lax',
    // expires_at is stored as UTC 'YYYY-MM-DD HH:MM:SS'; make that explicit so
    // the cookie does not drift by the host's timezone offset.
    `Expires=${new Date(`${expiresAt.replace(' ', 'T')}Z`).toUTCString()}`,
  ];
  if (config.cookieSecure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedCookie(config) {
  const attributes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.cookieSecure) attributes.push('Secure');
  return attributes.join('; ');
}

export function verifyPassword(config, submitted) {
  return typeof submitted === 'string' && submitted !== '' && secretsMatch(config.password, submitted);
}

/**
 * Checks the bearer token headless callers use. Returns false when no API
 * token is configured, so the feature is opt-in.
 */
export function verifyApiToken(config, req) {
  if (!config.apiToken) return false;

  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (req.headers['x-api-key'] ?? '');

  return presented !== '' && secretsMatch(config.apiToken, presented);
}

export const isPublicPath = (pathname) => PUBLIC_PATHS.has(pathname);

/**
 * Decides whether a request may proceed. Returns null when allowed, or the
 * reason it was refused.
 */
export function authorize(db, config, req, pathname) {
  if (!config.enabled) return null;
  if (isPublicPath(pathname)) return null;
  if (verifyApiToken(config, req)) return null;

  const { [SESSION_COOKIE]: token } = parseCookies(req.headers.cookie);
  return sessionIsValid(db, token) ? null : 'unauthenticated';
}

/** Best-effort client address for throttling. */
export function clientKey(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}
