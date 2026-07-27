/**
 * Environment parsing helpers shared by the config loaders. Each one throws on
 * malformed input rather than falling back to a default, so a typo in a
 * variable name or value fails at startup instead of silently changing
 * behaviour months later.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? '');

export function flag(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return false;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  if (truthy(value)) return true;
  throw new ConfigError(`${name} must be true or false, got "${value}"`);
}

export function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be a whole number, got "${raw}"`);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

export function choice(env, name, allowed, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')} — got "${raw}"`);
  }
  return raw;
}

/** Splits a comma-separated variable, rejecting entries outside `allowed`. */
export function list(env, name, allowed, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new ConfigError(`${name} contains "${value}"; allowed: ${allowed.join(', ')}`);
    }
  }
  return values;
}

/** Parses an http(s) URL, rejecting other schemes so a typo cannot become a file read. */
export function httpUrl(env, name, fallback = '') {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL, got "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be an http or https URL, got "${url.protocol}//"`);
  }
  return url.toString();
}
