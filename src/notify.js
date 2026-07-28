import { log, errorFields } from './log.js';
import { CLOSED_STATUSES, PRIORITIES } from './validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

/** ntfy's own priority scale, which does not line up with ours by name. */
const NTFY_PRIORITY = { low: '2', medium: '3', high: '4', critical: '5' };
const NTFY_TAGS = { low: 'information_source', medium: 'wrench', high: 'warning', critical: 'rotating_light' };

const SUBJECTS = {
  'ticket.created': (t) => `New ${t.priority} ticket: ${t.title}`,
  'ticket.resolved': (t) => `Resolved: ${t.title}`,
  'ticket.overdue': (t) => `Overdue since ${t.due_date}: ${t.title}`,
  'schedule.fired': (t) => `Maintenance due: ${t.title}`,
};

/**
 * Posts ticket events to a webhook. Every send is best-effort: a homelab
 * notifier that is down must never turn into a failed API request, so errors
 * are logged and swallowed.
 */
export function createNotifier(config = {}) {
  const settings = config.notify ?? {};
  const floor = PRIORITIES.indexOf(settings.minPriority ?? 'low');

  function wants(event, ticket) {
    if (!settings.enabled) return false;
    if (!settings.events?.has(event)) return false;
    return PRIORITIES.indexOf(ticket?.priority ?? 'low') >= floor;
  }

  /**
   * Sends one event. Returns a promise so tests and the maintenance tick can
   * await it; request handlers deliberately do not.
   */
  async function send(event, ticket) {
    if (!wants(event, ticket)) return false;

    const subject = SUBJECTS[event]?.(ticket) ?? `${event}: ${ticket.title}`;
    const request =
      settings.format === 'ntfy' ? ntfyRequest(subject, ticket) : jsonRequest(event, subject, ticket);

    try {
      const res = await fetch(settings.url, {
        ...request,
        signal: AbortSignal.timeout(settings.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        log.warn('notification rejected', { event, status: res.status, ticket_id: ticket.id });
        return false;
      }
      log.debug('notification sent', { event, ticket_id: ticket.id });
      return true;
    } catch (err) {
      log.warn('notification failed', { event, ticket_id: ticket.id, ...errorFields(err) });
      return false;
    }
  }

  /** Fire-and-forget form for request handlers, which must not wait on a webhook. */
  function sendDetached(event, ticket) {
    if (!wants(event, ticket)) return;
    void send(event, ticket);
  }

  /**
   * Announces tickets that have lapsed since the last sweep, marking each so it
   * is reported once rather than every day until someone deals with it.
   */
  async function sweepOverdue(db) {
    if (!settings.enabled || !settings.events?.has('ticket.overdue')) return [];

    const lapsed = db
      .prepare(
        `SELECT id, title, priority, due_date, status FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
            AND due_date IS NOT NULL
            AND due_date < date('now')
            AND overdue_notified_at IS NULL
          ORDER BY due_date ASC`,
      )
      .all();

    const mark = db.prepare(
      `UPDATE tickets SET overdue_notified_at = datetime('now') WHERE id = ?`,
    );

    const sent = [];
    for (const ticket of lapsed) {
      // Marked regardless of delivery outcome: a webhook that is down should
      // not queue up a burst of stale alerts for whenever it comes back.
      mark.run(ticket.id);
      if (await send('ticket.overdue', ticket)) sent.push(ticket.id);
    }
    return sent;
  }

  return { send, sendDetached, sweepOverdue, enabled: Boolean(settings.enabled) };

  function jsonRequest(event, subject, ticket) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        subject,
        ticket: {
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          device: ticket.device_name ?? null,
          due_date: ticket.due_date ?? null,
        },
      }),
    };
  }

  function ntfyRequest(subject, ticket) {
    const priority = ticket.priority ?? 'medium';
    const lines = [
      ticket.device_name && `Device: ${ticket.device_name}`,
      ticket.due_date && `Due: ${ticket.due_date}`,
      `Ticket #${ticket.id}`,
    ].filter(Boolean);

    return {
      method: 'POST',
      headers: {
        // Header values must stay on one line; a title is short but a ticket
        // title is user text, so newlines are folded out rather than trusted.
        Title: subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
        Priority: NTFY_PRIORITY[priority] ?? '3',
        Tags: NTFY_TAGS[priority] ?? 'wrench',
      },
      body: lines.join('\n'),
    };
  }
}
