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

/** Rejects oversized bodies before they are buffered into memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Route table. Patterns use :name segments, matched in order of declaration.
 * Handlers receive ({ db, params, query, body }) and return a JSON-serializable
 * value, or undefined for 204.
 */
const ROUTES = [
  ['GET', '/api/health', () => ({ status: 'ok' })],
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
].map(([method, pattern, handler]) => ({ method, handler, ...compile(pattern) }));

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
export function createApp(db) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      const served = await serveStatic(req, res, pathname).catch(() => false);
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
        params: matched.params,
        query: Object.fromEntries(url.searchParams),
        body,
      });

      if (result === undefined) return res.writeHead(204).end();
      sendJson(res, req.method === 'POST' ? 201 : 200, result);
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      console.error(`${req.method} ${pathname} failed:`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}

export function createServer(db) {
  return http.createServer(createApp(db));
}

/** Entry point — only runs when this file is executed directly. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ?? './data/homelab.db';

  const db = openDatabase(dbPath);
  const server = createServer(db);

  server.listen(port, host, () => {
    console.log(`homelab-ticket listening on http://${host}:${port} (db: ${dbPath})`);
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
