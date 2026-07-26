import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serves a file out of public/. Unknown paths fall back to index.html so the
 * client-side routes survive a refresh. Returns false if nothing was sent.
 */
export async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);

  // normalize() resolves any ".." before we join, so a crafted path cannot
  // escape PUBLIC_DIR.
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let info = await stat(filePath).catch(() => null);

  // Unknown non-asset path: hand back the app shell.
  if ((!info || info.isDirectory()) && !extname(safe)) {
    filePath = join(PUBLIC_DIR, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info || !info.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}
