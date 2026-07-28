/**
 * Structured logging. Every record carries the same fields in both formats, so
 * `text` stays readable in `docker logs` while `json` feeds a log shipper
 * without a parser in between.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export const LOG_LEVELS = Object.keys(LEVELS).filter((name) => name !== 'silent');

let threshold = LEVELS.info;
let format = 'text';
let sink = process.stdout;

export function configureLogging({ level = 'info', format: fmt = 'text' } = {}) {
  threshold = LEVELS[level] ?? LEVELS.info;
  format = fmt === 'json' ? 'json' : 'text';
}

/** Test seam — captures records instead of writing them. */
export function setLogSink(stream) {
  sink = stream;
}

function write(level, message, fields) {
  if (LEVELS[level] < threshold) return;

  const time = new Date().toISOString();
  if (format === 'json') {
    sink.write(`${JSON.stringify({ time, level, message, ...fields })}\n`);
    return;
  }

  const pairs = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  sink.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${pairs ? ` ${pairs}` : ''}\n`);
}

/** Quotes only when a value would otherwise be ambiguous to read or split on. */
function formatValue(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

export const log = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};

/**
 * Turns an Error into log fields. The stack is only attached at debug level so
 * routine 4xx noise stays one line each.
 */
export function errorFields(err) {
  return {
    error: err?.message ?? String(err),
    ...(threshold <= LEVELS.debug && err?.stack ? { stack: err.stack } : {}),
  };
}
