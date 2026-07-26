import { CLOSED_STATUSES } from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

/** Number of days without an update before an open ticket is "stale". */
const STALE_AFTER_DAYS = 14;

/** Everything the dashboard needs, in one round trip. */
export function getStats(db) {
  const scalar = (sql, params = []) => Object.values(db.prepare(sql).get(...params))[0];

  return {
    open_tickets: scalar(`SELECT COUNT(*) FROM tickets WHERE status NOT IN (${CLOSED_LIST})`),
    total_tickets: scalar('SELECT COUNT(*) FROM tickets'),
    total_devices: scalar('SELECT COUNT(*) FROM devices'),
    active_devices: scalar(`SELECT COUNT(*) FROM devices WHERE status = 'active'`),

    by_status: db
      .prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status')
      .all(),

    by_priority: db
      .prepare(
        `SELECT priority, COUNT(*) AS count FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
          GROUP BY priority`,
      )
      .all(),

    // Devices carrying the most unresolved work — the "what's on fire" list.
    hot_devices: db
      .prepare(
        `SELECT d.id, d.name, d.type, COUNT(t.id) AS open_tickets
           FROM devices d
           JOIN tickets t ON t.device_id = d.id AND t.status NOT IN (${CLOSED_LIST})
          GROUP BY d.id
          ORDER BY open_tickets DESC, d.name COLLATE NOCASE ASC
          LIMIT 5`,
      )
      .all(),

    overdue: db
      .prepare(
        `SELECT id, title, priority, due_date FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
            AND due_date IS NOT NULL
            AND due_date < date('now')
          ORDER BY due_date ASC`,
      )
      .all(),

    stale: db
      .prepare(
        `SELECT id, title, priority, updated_at FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
            AND updated_at < datetime('now', '-${STALE_AFTER_DAYS} days')
          ORDER BY updated_at ASC
          LIMIT 10`,
      )
      .all(),

    recently_resolved: db
      .prepare(
        `SELECT id, title, resolved_at FROM tickets
          WHERE resolved_at IS NOT NULL
          ORDER BY resolved_at DESC
          LIMIT 5`,
      )
      .all(),
  };
}
