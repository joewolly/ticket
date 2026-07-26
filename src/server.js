import http from 'node:http';
import { openDatabase } from './db.js';
import { serveStatic } from './static.js';
import { ValidationError } from './validate.js';
import {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
} from './api/devices.js';
import {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  addComment,
  deleteComment,
  listTags,
} from './api/tickets.js';
import { getStats } from './api/stats.js';
import {
  SESSION_COOKIE,
  authorize,
  clearFailures,
  clearedCookie,
  clientKey,
  createSession,
  destroyAllSessions,
  destroySession,
  loadAuthConfig,
  lockoutRemaining,
  parseCookies,
  purgeExpiredSessions,
  recordFailure,
  sessionCookie,
  verifyPassword,
} from './auth.js';

/** Rejects oversized bodies before they are buffered into memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Route table. Patterns use :name segments, matched in order of declaration.
 * Handlers receive ({ db, config, params, query, body, req, res }) and return a
 * JSON-serializable value, or undefined for 204. The optional fourth element
 * overrides the response status, which otherwise is 201 for POST and 200 for
 * everything else.
 */
const ROUTES = [
  ['GET', '/api/health', () => ({ status: 'ok' })],

  ['POST', '/api/auth/login', login, 200],
  ['POST', '/api/auth/logout', logout, 200],
  ['GET', '/api/auth/session', ({ config }) => ({ authenticated: true, enabled: config.enabled })],

  ['GET', '/api/stats', ({ db }) => getStats(db)],
  ['GET', '/api/tags', ({ db }) => listTags(db)],

  ['GET', '/api/devices', ({ db, query }) => listDevices(db, query)],
  ['POST', '/api/devices', ({ db, body }) => createDevice(db, body)],
  ['GET', '/api/devices/:id', ({ db, params }) => getDevice(db, params.id)],
  ['PATCH', '/api/devices/:id', ({ db, params, body }) => updateDevice(db, params.id, body)],
  ['DELETE', '/api/devices/:id', ({ db, params }) => deleteDevice(db, params.id)],

  ['GET', '/api/tickets', ({ db, query }) => listTickets(db, query)],
  ['POST', '/api/tickets', ({ db, body }) => createTicket(db, body)],
  ['GET', '/api/tickets/:id', ({ db, params }) => getTicket(db, params.id)],
  ['PATCH', '/api/tickets/:id', ({ db, params, body }) => updateTicket(db, params.id, body)],
  ['DELETE', '/api/tickets/:id', ({ db, params }) => deleteTicket(db, params.id)],

  ['POST', '/api/tickets/:id/comments', ({ db, params, body }) => addComment(db, params.id, body)],
  [
    'DELETE',
    '/api/tickets/:id/comments/:commentId',
    ({ db, params }) => deleteComment(db, params.id, params.commentId),
  ],
].map(([method, pattern, handler, status = method === 'POST' ? 201 : 200]) => ({
  method,
  handler,
  status,
  ...compile(pattern),
}));

/* ---- Auth handlers ------------------------------------------------------ */

function login({ db, config, body, req, res }) {
  if (!config.enabled) return { authenticated: true, enabled: false };

  const key = clientKey(req);
  const locked = lockoutRemaining(key);
  if (locked) {
    throw Object.assign(new Error(`Too many attempts. Try again in ${locked} seconds.`), {
      status: 429,
    });
  }

  if (!verifyPassword(config, body.password)) {
    recordFailure(key);
    throw Object.assign(new Error('Incorrect password'), { status: 401 });
  }

  clearFailures(key);
  const { token, expiresAt } = createSession(db, config, req.headers['user-agent']);
  res.setHeader('Set-Cookie', sessionCookie(token, config, expiresAt));
  return { authenticated: true, enabled: true };
}

function logout({ db, config, body, req, res }) {
  const { [SESSION_COOKIE]: token } = parseCookies(req.headers.cookie);

  if (body?.everywhere) destroyAllSessions(db);
  else destroySession(db, token);

  res.setHeader('Set-Cookie', clearedCookie(config));
  return { authenticated: false };
}

/** Turns '/api/tickets/:id' into a regex plus the list of parameter names. */
function compile(pattern) {
  const names = [];
  const source = pattern.replace(/:(\w+)/g, (_, name) => {
    names.push(name);
    return '(\\d+)';
  });
  return { regex: new RegExp(`^${source}$`), names };
}

function match(method, pathname) {
  let pathMatched = false;

  for (const route of ROUTES) {
    const result = route.regex.exec(pathname);
    if (!result) continue;
    pathMatched = true;
    if (route.method !== method) continue;

    const params = {};
    route.names.forEach((name, i) => {
      params[name] = Number(result[i + 1]);
    });
    return { route, params };
  }

  // Distinguishes "no such route" from "wrong verb for this route".
  return pathMatched ? { methodNotAllowed: true } : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ValidationError('Request body must be a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new ValidationError('Request body is not valid JSON'));
      }
    });
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** Builds the request handler against an already-open database. */
export function createApp(db, config = { enabled: false }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    // Nothing but the login page and its endpoint is reachable without a
    // session, so this gate runs before routing and before any file is read.
    if (authorize(db, config, req, pathname)) {
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 401, { error: 'Authentication required' });
      }
      return res.writeHead(302, { Location: '/login' }).end();
    }

    if (!pathname.startsWith('/api/')) {
      // An authenticated visitor has no use for the login page.
      if (pathname === '/login' && (!config.enabled || !authorize(db, config, req, '/'))) {
        return res.writeHead(302, { Location: '/' }).end();
      }

      const file = pathname === '/login' ? '/login.html' : pathname;
      const served = await serveStatic(req, res, file).catch(() => false);
      if (!served) sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const matched = match(req.method, pathname);
    if (!matched) return sendJson(res, 404, { error: `No route for ${pathname}` });
    if (matched.methodNotAllowed) {
      return sendJson(res, 405, { error: `${req.method} not allowed on ${pathname}` });
    }

    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await matched.route.handler({
        db,
        config,
        params: matched.params,
        query: Object.fromEntries(url.searchParams),
        body,
        req,
        res,
      });

      if (result === undefined) return res.writeHead(204).end();
      sendJson(res, matched.route.status, result);
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      console.error(`${req.method} ${pathname} failed:`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}

export function createServer(db, config) {
  return http.createServer(createApp(db, config));
}

/** Entry point — only runs when this file is executed directly. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ?? './data/homelab.db';

  let config;
  try {
    config = loadAuthConfig();
  } catch (err) {
    console.error(`\nRefusing to start: ${err.message}\n`);
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  purgeExpiredSessions(db);
  const server = createServer(db, config);

  server.listen(port, host, () => {
    console.log(`homelab-ticket listening on http://${host}:${port} (db: ${dbPath})`);
    console.log(
      config.enabled
        ? `auth: password${config.apiToken ? ' + API token' : ''}`
        : 'auth: DISABLED — anyone who can reach this port has full access',
    );
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
