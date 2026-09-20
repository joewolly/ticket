export const DEVICE_TYPES = [
  'server',
  'nas',
  'network',
  'vm',
  'container-host',
  'iot',
  'workstation',
  'peripheral',
  'other',
];

export const DEVICE_STATUSES = ['active', 'spare', 'retired'];

export const TICKET_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
export const TICKET_QUEUES = ['inbox', 'next', 'someday'];

/** Statuses that mean the ticket no longer needs attention. */
export const CLOSED_STATUSES = ['resolved', 'closed'];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

/** Thrown for bad input; the server turns this into a 400. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** Thrown when a referenced row does not exist; the server turns this into a 404. */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

const MAX_SHORT = 200;
const MAX_LONG = 20000;

/**
 * Normalizes a free-text field: trims, collapses an empty string to null,
 * and enforces a length ceiling so a runaway client cannot bloat the file.
 */
export function optionalText(value, field, max = MAX_SHORT) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

export function requiredText(value, field, max = MAX_SHORT) {
  const text = optionalText(value, field, max);
  if (text === null) throw new ValidationError(`${field} is required`);
  return text;
}

export function bodyText(value, field) {
  return optionalText(value, field, MAX_LONG) ?? '';
}

export function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) throw new ValidationError(`${field} is required`);
    return fallback;
  }
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/** Parses an id from a URL segment or JSON body. Returns null when absent. */
export function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return id;
}

export function requiredId(value, field) {
  const id = optionalId(value, field);
  if (id === null) throw new ValidationError(`${field} is required`);
  return id;
}

/** Accepts an ISO date (YYYY-MM-DD); rejects anything else. */
export function optionalDate(value, field) {
  const text = optionalText(value, field, 10);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) {
    throw new ValidationError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  return text;
}

/**
 * Validates a link target. Only http and https are accepted — a stored
 * `javascript:` or `data:` URL would become a script the moment the UI renders
 * it as an anchor, so the scheme is constrained here rather than at the point
 * of display, where one forgetful template would undo it.
 */
export function httpUrl(value, field) {
  const text = requiredText(value, field, 2000);

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ValidationError(`${field} must be a valid URL, including the scheme`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`${field} must be an http or https URL`);
  }
  return url.toString();
}

/**
 * A non-negative decimal amount, for a device's purchase cost. Stored as a
 * REAL, so it is rounded to cents here rather than carrying a float's tail of
 * noise into the database. An empty value clears the field.
 */
export function optionalMoney(value, field, { max = 1_000_000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${field} must be a number`);
  if (number < 0) throw new ValidationError(`${field} must not be negative`);
  if (number > max) throw new ValidationError(`${field} must be ${max} or less`);
  return Math.round(number * 100) / 100;
}

/** A whole number within bounds, for intervals and offsets. */
export function boundedInt(value, field, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) throw new ValidationError(`${field} is required`);
    return fallback;
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) throw new ValidationError(`${field} must be a whole number`);
  if (number < min || number > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

/** Accepts real booleans and the strings a form or query string would send. */
export function boolean(value, field, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw new ValidationError(`${field} must be true or false`);
}

/**
 * Normalizes a tag list: lowercased, deduplicated, whitespace collapsed to
 * hyphens so "Needs Parts" and "needs-parts" are the same tag.
 */
export function tagList(value, field = 'tags') {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new ValidationError(`${field} must contain only strings`);
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag === '') continue;
    if (tag.length > 50) throw new ValidationError(`tag "${tag}" is longer than 50 characters`);
    seen.add(tag);
  }
  if (seen.size > 25) throw new ValidationError(`${field} may contain at most 25 tags`);
  return [...seen];
}
