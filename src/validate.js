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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ValidationError(`${field} must be a valid date in YYYY-MM-DD format`);
  }
  return text;
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
