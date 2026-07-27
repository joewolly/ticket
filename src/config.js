import { loadAuthConfig } from './auth.js';
import { LOG_LEVELS } from './log.js';
import { PRIORITIES } from './validate.js';
import { choice, flag, httpUrl, integer, list } from './env.js';

/** Events a webhook can be told about. */
export const NOTIFY_EVENTS = [
  'ticket.created',
  'ticket.resolved',
  'ticket.overdue',
  'schedule.fired',
];

const DEFAULT_NOTIFY_EVENTS = ['ticket.created', 'ticket.overdue', 'schedule.fired'];

/**
 * The whole runtime configuration, read once at startup. Everything beyond
 * authentication is optional and off by default: an instance that sets only
 * AUTH_PASSWORD behaves exactly as it did before any of this existed.
 */
export function loadConfig(env = process.env) {
  const notifyUrl = httpUrl(env, 'NOTIFY_URL');
  const backupDir = env.BACKUP_DIR?.trim() ?? '';

  return {
    ...loadAuthConfig(env),

    // Only consult X-Forwarded-For when a proxy really is in front — see the
    // note on clientKey() for why this cuts both ways.
    trustProxy: flag(env, 'TRUST_PROXY'),
    publicHealth: flag(env, 'PUBLIC_HEALTH'),

    rateLimit: {
      // 0 disables. The default is generous enough that a human clicking around
      // will never see it and a runaway loop will.
      perMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 300, { max: 1_000_000 }),
    },

    log: {
      level: choice(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
      format: choice(env, 'LOG_FORMAT', ['text', 'json'], 'text'),
    },

    notify: {
      url: notifyUrl,
      enabled: notifyUrl !== '',
      // ntfy wants a plain-text body with metadata in headers; everything else
      // in this space accepts a JSON post.
      format: choice(env, 'NOTIFY_FORMAT', ['json', 'ntfy'], 'json'),
      events: new Set(list(env, 'NOTIFY_EVENTS', NOTIFY_EVENTS, DEFAULT_NOTIFY_EVENTS)),
      minPriority: choice(env, 'NOTIFY_MIN_PRIORITY', PRIORITIES, 'low'),
      timeoutMs: integer(env, 'NOTIFY_TIMEOUT_MS', 5000, { min: 100, max: 60_000 }),
    },

    backup: {
      dir: backupDir,
      enabled: backupDir !== '',
      intervalHours: integer(env, 'BACKUP_INTERVAL_HOURS', 24, { min: 1, max: 8760 }),
      keep: integer(env, 'BACKUP_KEEP', 7, { min: 1, max: 1000 }),
    },

    // How often schedules are materialized and overdue tickets swept. 0 turns
    // the timer off for anyone who would rather drive it from cron.
    maintenanceMinutes: integer(env, 'MAINTENANCE_INTERVAL_MINUTES', 60, { max: 10_080 }),
  };
}
