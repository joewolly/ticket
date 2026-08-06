import { CLOSED_STATUSES, PRIORITIES, TICKET_STATUSES, DEVICE_STATUSES } from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

const STALE_AFTER_DAYS = 14;

/**
 * Prometheus text exposition, so a homelab that already runs Grafana can graph
 * its own backlog next to everything else.
 *
 * Every label value here comes from a fixed enum rather than user text, which
 * keeps the output well-formed without a per-value escaping pass, and keeps
 * cardinality bounded — a gauge per device name would quietly turn a ticket
 * tracker into a metrics problem.
 */
export function renderMetrics(db, { warrantyDays = 30 } = {}) {
  const scalar = (sql) => Object.values(db.prepare(sql).get())[0];
  // 0 means the sweep is disabled, not a zero-day window; show the default span
  // so the gauge stays meaningful either way.
  const warrantyWindow = warrantyDays > 0 ? warrantyDays : 30;
  const counts = (sql) => new Map(db.prepare(sql).all().map(({ key, count }) => [key, count]));

  const byPriority = counts(
    `SELECT priority AS key, COUNT(*) AS count FROM tickets
      WHERE status NOT IN (${CLOSED_LIST}) GROUP BY priority`,
  );
  const byStatus = counts('SELECT status AS key, COUNT(*) AS count FROM tickets GROUP BY status');
  const byDeviceStatus = counts(
    'SELECT status AS key, COUNT(*) AS count FROM devices GROUP BY status',
  );

  const out = [];
  const metric = (name, help, type, samples) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      out.push(`${name}${labels} ${value}`);
    }
  };

  metric('homelab_tickets_open', 'Unresolved tickets by priority.', 'gauge',
    PRIORITIES.map((priority) => [`{priority="${priority}"}`, byPriority.get(priority) ?? 0]));

  metric('homelab_tickets', 'All tickets by status.', 'gauge',
    TICKET_STATUSES.map((status) => [`{status="${status}"}`, byStatus.get(status) ?? 0]));

  metric('homelab_tickets_overdue', 'Unresolved tickets past their due date.', 'gauge', [
    ['', scalar(`SELECT COUNT(*) FROM tickets
                  WHERE status NOT IN (${CLOSED_LIST})
                    AND due_date IS NOT NULL AND due_date < date('now')`)],
  ]);

  metric('homelab_tickets_stale',
    `Unresolved tickets with no activity for ${STALE_AFTER_DAYS} days.`, 'gauge', [
      ['', scalar(`SELECT COUNT(*) FROM tickets
                    WHERE status NOT IN (${CLOSED_LIST})
                      AND updated_at < datetime('now', '-${STALE_AFTER_DAYS} days')`)],
    ]);

  metric('homelab_devices', 'Devices by status.', 'gauge',
    DEVICE_STATUSES.map((status) => [`{status="${status}"}`, byDeviceStatus.get(status) ?? 0]));

  metric('homelab_schedules_active', 'Maintenance schedules that are not paused.', 'gauge', [
    ['', scalar('SELECT COUNT(*) FROM schedules WHERE paused = 0')],
  ]);

  metric('homelab_schedules_due', 'Active schedules at or past their trigger date.', 'gauge', [
    ['', scalar(`SELECT COUNT(*) FROM schedules
                  WHERE paused = 0
                    AND date(next_due, '-' || lead_days || ' days') <= date('now')`)],
  ]);

  metric('homelab_comments', 'Notes recorded across all tickets.', 'counter', [
    ['', scalar('SELECT COUNT(*) FROM comments')],
  ]);

  metric('homelab_warranties_expiring',
    `Non-retired devices whose warranty lapses within ${warrantyWindow} days.`, 'gauge', [
      ['', scalar(`SELECT COUNT(*) FROM devices
                    WHERE status != 'retired' AND warranty_expires IS NOT NULL
                      AND warranty_expires <= date('now', '+${warrantyWindow} days')`)],
    ]);

  return `${out.join('\n')}\n`;
}
