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
  'ticket.due_soon': (t) => `Due ${t.due_date}: ${t.title}`,
  'schedule.fired': (t) => `Maintenance due: ${t.title}`,
};

const DIGEST_INTERVAL_DAYS = { daily: 1, weekly: 7 };

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
   * Sends one ticket-shaped event. Returns a promise so tests and the
   * maintenance tick can await it; request handlers deliberately do not.
   */
  async function send(event, ticket) {
    if (!wants(event, ticket)) return false;

    const subject = SUBJECTS[event]?.(ticket) ?? `${event}: ${ticket.title}`;
    const request =
      settings.format === 'ntfy' ? ntfyRequest(subject, ticket) : jsonRequest(event, subject, ticket);

    return deliver(request, { event, ticket_id: ticket.id });
  }

  /** Posts a prepared request and maps the outcome to true/false, never throwing. */
  async function deliver(request, meta) {
    try {
      const res = await fetch(settings.url, {
        ...request,
        signal: AbortSignal.timeout(settings.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        log.warn('notification rejected', { ...meta, status: res.status });
        return false;
      }
      log.debug('notification sent', meta);
      return true;
    } catch (err) {
      log.warn('notification failed', { ...meta, ...errorFields(err) });
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

  /**
   * The mirror image of the overdue sweep: tickets whose due date is coming up
   * within the reminder window, announced once so a deadline gets a nudge
   * before it lapses rather than only a reproach after. A ticket already past
   * due is left to the overdue sweep.
   */
  async function sweepDueSoon(db) {
    const days = settings.reminderDays ?? 0;
    if (!settings.enabled || !settings.events?.has('ticket.due_soon') || days <= 0) return [];

    const soon = db
      .prepare(
        `SELECT id, title, priority, due_date, status FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
            AND due_date IS NOT NULL
            AND due_soon_notified_at IS NULL
            AND due_date >= date('now')
            AND due_date <= date('now', '+' || :days || ' days')
          ORDER BY due_date ASC`,
      )
      .all({ days });

    // The claim is conditional on the ticket still being unclaimed, so if an
    // ad-hoc /api/maintenance/run overlaps the timer's sweep only one of them
    // wins the row and the ticket is announced exactly once.
    const mark = db.prepare(
      `UPDATE tickets SET due_soon_notified_at = datetime('now')
        WHERE id = ? AND due_soon_notified_at IS NULL`,
    );

    const sent = [];
    for (const ticket of soon) {
      if (mark.run(ticket.id).changes === 0) continue; // another sweep took it
      if (await send('ticket.due_soon', ticket)) sent.push(ticket.id);
    }
    return sent;
  }

  /**
   * A rolled-up summary of the backlog, sent at most once per configured
   * cadence. The last-sent time lives in the `meta` table so the cadence
   * survives restarts; it is advanced only on a successful send, so a webhook
   * that is briefly down catches up on the next tick rather than skipping a
   * whole week.
   */
  async function maybeSendDigest(db) {
    const cadence = settings.digest ?? 'off';
    if (!settings.enabled || cadence === 'off') return false;

    // A little slack so an hourly tick arriving a minute early is not bumped a
    // whole cycle later.
    const threshold = DIGEST_INTERVAL_DAYS[cadence] - 1 / 24;
    const previous =
      db.prepare(`SELECT value FROM meta WHERE key = 'digest_last_sent'`).get()?.value ?? null;

    // Claim the send atomically: stamp the timestamp only if the cadence is
    // actually due. Two overlapping calls both try this, but SQLite serializes
    // them and the second sees a fresh timestamp, so only one claim reports a
    // changed row — the other backs off without sending a duplicate.
    const claim = db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('digest_last_sent', datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = datetime('now')
            WHERE julianday('now') - julianday(meta.value) >= :threshold`,
      )
      .run({ threshold });
    if (claim.changes === 0) return false; // not due yet, or another call claimed it

    const summary = buildDigest(db);
    const request = settings.format === 'ntfy' ? ntfyDigest(summary) : jsonDigest(summary);

    if (await deliver(request, { event: 'digest' })) return true;

    // Delivery failed: release the lease back to its old value so the next tick
    // retries rather than skipping this whole cadence.
    if (previous === null) {
      db.prepare(`DELETE FROM meta WHERE key = 'digest_last_sent'`).run();
    } else {
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'digest_last_sent'`).run(previous);
    }
    return false;
  }

  return {
    send,
    sendDetached,
    sweepOverdue,
    sweepDueSoon,
    maybeSendDigest,
    enabled: Boolean(settings.enabled),
  };

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

  function jsonDigest(summary) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'digest', subject: digestSubject(summary), ...summary }),
    };
  }

  function ntfyDigest(summary) {
    const lines = [
      `${summary.open} open · ${summary.overdue} overdue · ${summary.stale} stale`,
      ...summary.upcoming.map((t) => `• ${t.due_date}  ${t.title}`),
    ];
    return {
      method: 'POST',
      headers: {
        Title: digestSubject(summary).replace(/[\r\n]+/g, ' ').slice(0, 200),
        Priority: summary.overdue > 0 ? '4' : '3',
        Tags: 'clipboard',
      },
      body: lines.join('\n'),
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

/** Number of days without an update before an open ticket counts as stale. */
const STALE_AFTER_DAYS = 14;

/**
 * The backlog in one glance: how much is open, how much has slipped, and what
 * is coming up in the next week. Shared by both digest formats.
 */
function buildDigest(db) {
  const scalar = (sql) => Object.values(db.prepare(sql).get())[0];

  return {
    open: scalar(`SELECT COUNT(*) FROM tickets WHERE status NOT IN (${CLOSED_LIST})`),
    overdue: scalar(
      `SELECT COUNT(*) FROM tickets WHERE status NOT IN (${CLOSED_LIST})
         AND due_date IS NOT NULL AND due_date < date('now')`,
    ),
    stale: scalar(
      `SELECT COUNT(*) FROM tickets WHERE status NOT IN (${CLOSED_LIST})
         AND updated_at < datetime('now', '-${STALE_AFTER_DAYS} days')`,
    ),
    upcoming: db
      .prepare(
        `SELECT id, title, priority, due_date FROM tickets
          WHERE status NOT IN (${CLOSED_LIST})
            AND due_date IS NOT NULL
            AND due_date >= date('now')
            AND due_date <= date('now', '+7 days')
          ORDER BY due_date ASC LIMIT 10`,
      )
      .all(),
  };
}

function digestSubject({ open, overdue }) {
  const tail = overdue > 0 ? `, ${overdue} overdue` : '';
  return `Homelab: ${open} open ticket${open === 1 ? '' : 's'}${tail}`;
}
