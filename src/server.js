import http from 'node:http';
import { openDatabase } from './db.js';
import { serveStatic } from './static.js';
import { ValidationError } from './validate.js';
import { loadConfig } from './config.js';
import { configureLogging, log, errorFields } from './log.js';
import { createRateLimiter } from './ratelimit.js';
import { createNotifier } from './notify.js';
import { runBackupSafely } from './backup.js';
import { sweepWarranties } from './api/warranty.js';
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
  addLink,
  deleteLink,
  listTags,
  bulkUpdateTickets,
} from './api/tickets.js';
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedules,
} from './api/schedules.js';
import { exportEntity } from './api/export.js';
import { renderMetrics } from './api/metrics.js';
import { renderCalendar } from './api/calendar.js';
import { getStats } from './api/stats.js';
import {
  addAttachment,
  getAttachment,
  deleteAttachment,
  isInline,
} from './api/attachments.js';
import {
  SESSION_COOKIE,
  authorize,
  clearFailures,
  clearedCookie,
  clientKey,
  createSession,
  destroyAllSessions,
  destroySession,
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
 * Sent on every response, including static files and redirects.
 *
 * 'unsafe-inline' is present for styles only: the UI sets CSS custom properties
 * through style attributes to colour badges by status. Scripts stay under a
 * strict 'self' — there is no inline script anywhere in the app, and keeping it
 * that way is what makes the script directive worth having.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
};

/**
 * Route table. Patterns use :name segments, matched in order of declaration.
 * Handlers receive ({ db, config, notifier, params, query, body, req, res }) and
 * return a JSON-serializable value, or undefined for 204. A handler that writes
 * to `res` itself (the export and metrics endpoints) is left alone. The optional
 * fourth element overrides the response status, which otherwise is 201 for POST
 * and 200 for everything else.
 */
const ROUTES = [
  ['GET', '/api/health', () => ({ status: 'ok' })],

  ['POST', '/api/auth/login', login, 200],
  ['POST', '/api/auth/logout', logout, 200],
  ['GET', '/api/auth/session', ({ config }) => ({ authenticated: true, enabled: config.enabled })],

  ['GET', '/api/stats', ({ db }) => getStats(db)],
  ['GET', '/api/tags', ({ db }) => listTags(db)],
  ['GET', '/api/metrics', sendMetrics],
  ['GET', '/api/calendar.ics', sendCalendar],
  ['GET', '/api/export', sendExport],
  ['POST', '/api/maintenance/run', runMaintenance, 200],

  ['GET', '/api/devices', ({ db, query }) => listDevices(db, query)],
  ['POST', '/api/devices', ({ db, body }) => createDevice(db, body)],
  ['GET', '/api/devices/:id', ({ db, params }) => getDevice(db, params.id)],
  ['PATCH', '/api/devices/:id', ({ db, params, body }) => updateDevice(db, params.id, body)],
  ['DELETE', '/api/devices/:id', ({ db, params }) => deleteDevice(db, params.id)],

  ['GET', '/api/schedules', ({ db, query }) => listSchedules(db, query)],
  ['POST', '/api/schedules', ({ db, body }) => createSchedule(db, body)],
  ['GET', '/api/schedules/:id', ({ db, params }) => getSchedule(db, params.id)],
  ['PATCH', '/api/schedules/:id', ({ db, params, body }) => updateSchedule(db, params.id, body)],
  ['DELETE', '/api/schedules/:id', ({ db, params }) => deleteSchedule(db, params.id)],

  ['GET', '/api/tickets', ({ db, query }) => listTickets(db, query)],
  ['POST', '/api/tickets/bulk', ({ db, body }) => bulkUpdateTickets(db, body), 200],
  ['POST', '/api/tickets', createTicketAndNotify],
  ['GET', '/api/tickets/:id', ({ db, params }) => getTicket(db, params.id)],
  ['PATCH', '/api/tickets/:id', updateTicketAndNotify],
  ['DELETE', '/api/tickets/:id', ({ db, params }) => deleteTicket(db, params.id)],

  ['POST', '/api/tickets/:id/comments', ({ db, params, body }) => addComment(db, params.id, body)],
  [
    'DELETE',
    '/api/tickets/:id/comments/:commentId',
    ({ db, params }) => deleteComment(db, params.id, params.commentId),
  ],

  ['POST', '/api/tickets/:id/links', ({ db, params, body }) => addLink(db, params.id, body)],
  [
    'DELETE',
    '/api/tickets/:id/links/:linkId',
    ({ db, params }) => deleteLink(db, params.id, params.linkId),
  ],

  // The upload reads raw bytes, not JSON: the file rides in the body, its name
  // and type in headers. The `true` flag routes it past the JSON body parser.
  ['POST', '/api/tickets/:id/attachments', uploadAttachment, 201, true],
  ['GET', '/api/attachments/:id', sendAttachment],
  [
    'DELETE',
    '/api/tickets/:id/attachments/:attachmentId',
    ({ db, params }) => deleteAttachment(db, params.id, params.attachmentId),
  ],
].map(([method, pattern, handler, status = method === 'POST' ? 201 : 200, raw = false]) => ({
  method,
  handler,
  status,
  raw,
  ...compile(pattern),
}));

/* ---- Handlers that need more than the data layer ------------------------ */

function createTicketAndNotify({ db, body, notifier }) {
  const ticket = createTicket(db, body);
  notifier.sendDetached('ticket.created', ticket);
  return ticket;
}

function updateTicketAndNotify({ db, params, body, notifier }) {
  const before = getTicket(db, params.id);
  const ticket = updateTicket(db, params.id, body);

  const closed = ['resolved', 'closed'];
  if (!closed.includes(before.status) && closed.includes(ticket.status)) {
    notifier.sendDetached('ticket.resolved', ticket);
  }
  return ticket;
}

/**
 * Materializes due schedules and announces newly lapsed tickets. Exposed so an
 * operator who would rather drive this from cron can set
 * MAINTENANCE_INTERVAL_MINUTES=0 and post here instead.
 */
async function runMaintenance({ db, config, notifier }) {
  const fired = runSchedules(db);
  for (const { ticket } of fired) notifier.sendDetached('schedule.fired', ticket);

  const warranties = sweepWarranties(db, { leadDays: config.warrantyDays });
  for (const { ticket } of warranties) notifier.sendDetached('ticket.created', ticket);

  const overdue = await notifier.sweepOverdue(db);
  const dueSoon = await notifier.sweepDueSoon(db);
  await notifier.maybeSendDigest(db);
  purgeExpiredSessions(db);

  return {
    schedules_fired: fired.map(({ schedule_id, ticket }) => ({
      schedule_id,
      ticket_id: ticket.id,
    })),
    warranties_flagged: warranties.map(({ device_id, ticket }) => ({
      device_id,
      ticket_id: ticket.id,
    })),
    overdue_notified: overdue,
    due_soon_notified: dueSoon,
  };
}

function uploadAttachment({ db, params, body, req }) {
  return addAttachment(db, params.id, {
    filename: decodeFilename(req.headers['x-filename']),
    contentType: req.headers['content-type'],
    data: body,
  });
}

/**
 * The client percent-encodes the filename so a non-Latin-1 name survives the
 * header. Decode it here; a malformed sequence falls back to the raw value
 * rather than throwing, since cleanFilename will sanitize whatever it gets.
 */
function decodeFilename(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Streams a stored attachment back. Images are shown inline so the ticket view
 * can render a thumbnail; everything else is a download. `nosniff` (set
 * globally) plus the short type allowlist is what makes serving user bytes from
 * our own origin safe.
 */
function sendAttachment({ db, params, res }) {
  const file = getAttachment(db, params.id);
  const disposition = isInline(file.content_type) ? 'inline' : 'attachment';

  res.writeHead(200, {
    'Content-Type': file.content_type,
    'Content-Length': file.size,
    'Content-Disposition': `${disposition}; filename="${file.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.from(file.data));
}

function sendExport({ db, query, res }) {
  const { contentType, filename, body } = exportEntity(db, query);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    // The filename is generated from an enum and a date, so it needs no
    // escaping, but quoting it keeps well-behaved clients predictable.
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendMetrics({ db, config, res }) {
  const body = renderMetrics(db, { warrantyDays: config.warrantyDays });
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendCalendar({ db, res }) {
  const body = renderCalendar(db);
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': 'inline; filename="homelab.ics"',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ---- Auth handlers ------------------------------------------------------ */

function login({ db, config, body, req, res }) {
  if (!config.enabled) return { authenticated: true, enabled: false };

  const key = clientKey(req, config);
  const locked = lockoutRemaining(key);
  if (locked) {
    throw Object.assign(new Error(`Too many attempts. Try again in ${locked} seconds.`), {
      status: 429,
    });
  }

  if (!verifyPassword(config, body.password)) {
    recordFailure(key);
    log.warn('failed login', { client: key });
    throw Object.assign(new Error('Incorrect password'), { status: 401 });
  }

  clearFailures(key);
  const { token, expiresAt } = createSession(db, config, req.headers['user-agent']);
  res.setHeader('Set-Cookie', sessionCookie(token, config, expiresAt));
  log.info('signed in', { client: key });
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

/** Buffers a raw request body (an uploaded file) under the same size ceiling. */
function readRawBody(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    // API responses carry the contents of a private tracker; keeping them out
    // of any intermediate cache costs nothing on a LAN.
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** Builds the request handler against an already-open database. */
export function createApp(db, config = { enabled: false }) {
  const limiter = createRateLimiter(config.rateLimit);
  const notifier = createNotifier(config);

  return async function handle(req, res) {
    const startedAt = process.hrtime.bigint();
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(header, value);
    }

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: ms.toFixed(1),
      };
      // Ordinary traffic is debug-level so the default log stays a record of
      // things that happened rather than a page-by-page access log.
      if (res.statusCode >= 500) log.error('request failed', fields);
      else if (res.statusCode >= 400) log.warn('request rejected', fields);
      else log.debug('request', fields);
    });

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

    // Applied to the API only: a page load pulls several static assets, and the
    // work worth protecting is all behind these routes anyway.
    const quota = limiter.check(clientKey(req, config));
    if (!quota.allowed) {
      res.setHeader('Retry-After', String(quota.retryAfter));
      return sendJson(res, 429, {
        error: `Rate limit exceeded. Retry in ${quota.retryAfter} seconds.`,
      });
    }

    const matched = match(req.method, pathname);
    if (!matched) return sendJson(res, 404, { error: `No route for ${pathname}` });
    if (matched.methodNotAllowed) {
      return sendJson(res, 405, { error: `${req.method} not allowed on ${pathname}` });
    }

    try {
      const body =
        req.method === 'GET' || req.method === 'DELETE'
          ? {}
          : matched.route.raw
            ? await readRawBody(req)
            : await readBody(req);
      const result = await matched.route.handler({
        db,
        config,
        notifier,
        params: matched.params,
        query: Object.fromEntries(url.searchParams),
        body,
        req,
        res,
      });

      // Export and metrics write their own non-JSON responses.
      if (res.writableEnded || res.headersSent) return;
      if (result === undefined) return res.writeHead(204).end();
      sendJson(res, matched.route.status, result);
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      log.error('unhandled request error', {
        method: req.method,
        path: pathname,
        ...errorFields(err),
      });
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}

export function createServer(db, config) {
  return http.createServer(createApp(db, config));
}

/**
 * Starts the periodic sweeps: due schedules, overdue notifications, expired
 * sessions, and backups. Returns a stop function so the timers do not outlive
 * the server. Each tick is wrapped so a failure never kills the interval.
 */
export function startMaintenance(db, config) {
  const notifier = createNotifier(config);
  const timers = [];

  const tick = async () => {
    try {
      const fired = runSchedules(db);
      for (const { ticket } of fired) await notifier.send('schedule.fired', ticket);
      if (fired.length > 0) log.info('schedules fired', { count: fired.length });

      const warranties = sweepWarranties(db, { leadDays: config.warrantyDays });
      for (const { ticket } of warranties) await notifier.send('ticket.created', ticket);
      if (warranties.length > 0) log.info('warranties flagged', { count: warranties.length });

      const overdue = await notifier.sweepOverdue(db);
      if (overdue.length > 0) log.info('overdue notified', { count: overdue.length });

      const dueSoon = await notifier.sweepDueSoon(db);
      if (dueSoon.length > 0) log.info('due-soon notified', { count: dueSoon.length });

      if (await notifier.maybeSendDigest(db)) log.info('digest sent');

      purgeExpiredSessions(db);
    } catch (err) {
      log.error('maintenance tick failed', errorFields(err));
    }
  };

  if (config.maintenanceMinutes > 0) {
    void tick();
    timers.push(setInterval(tick, config.maintenanceMinutes * 60_000));
  }

  if (config.backup?.enabled) {
    void runBackupSafely(db, config.backup);
    timers.push(
      setInterval(() => void runBackupSafely(db, config.backup), config.backup.intervalHours * 3600_000),
    );
  }

  // Timers must not be what keeps the process alive; the listening socket is.
  for (const timer of timers) timer.unref();
  return () => timers.forEach(clearInterval);
}

/** Entry point — only runs when this file is executed directly. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ?? './data/homelab.db';

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\nRefusing to start: ${err.message}\n`);
    process.exit(1);
  }

  configureLogging(config.log);

  const db = openDatabase(dbPath);
  purgeExpiredSessions(db);
  const server = createServer(db, config);
  const stopMaintenance = startMaintenance(db, config);

  server.listen(port, host, () => {
    log.info('listening', {
      url: `http://${host}:${port}`,
      db: dbPath,
      auth: config.enabled ? (config.apiToken ? 'password+token' : 'password') : 'DISABLED',
      notify: config.notify.enabled ? config.notify.format : 'off',
      backups: config.backup.enabled ? `every ${config.backup.intervalHours}h` : 'off',
    });
    if (!config.enabled) {
      log.warn('authentication is disabled — anyone who can reach this port has full access');
    }
  });

  const shutdown = (signal) => {
    log.info('shutting down', { signal });
    stopMaintenance();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
