import { transaction } from '../db.js';
import { createTicket } from './tickets.js';
import { log, errorFields } from '../log.js';

/**
 * Opens a ticket for every device whose warranty is about to lapse, so the
 * inventory warns you while an RMA is still free rather than a week after it
 * stopped being. Like the overdue sweep, each device is flagged the moment it
 * fires (`warranty_notified_at`), so it produces exactly one ticket rather than
 * a fresh one on every pass. Editing the warranty date clears the flag, which
 * is what lets a renewed device warn again next time.
 *
 * Retired devices are skipped: a warranty on a box you no longer run is not
 * news. `leadDays` is how far ahead to look; 0 disables the sweep entirely.
 */
export function sweepWarranties(db, { leadDays = 30, today = currentDate(db) } = {}) {
  if (!(leadDays > 0)) return [];

  const due = db
    .prepare(
      `SELECT id, name, warranty_expires FROM devices
        WHERE status != 'retired'
          AND warranty_expires IS NOT NULL
          AND warranty_notified_at IS NULL
          AND warranty_expires <= date(:today, '+' || :leadDays || ' days')
        ORDER BY warranty_expires ASC, id ASC`,
    )
    .all({ today, leadDays });

  const opened = [];
  for (const device of due) {
    try {
      opened.push(open(db, device));
    } catch (err) {
      // One bad device must not stop the rest of the sweep.
      log.error('warranty alert failed', { device_id: device.id, ...errorFields(err) });
    }
  }
  return opened;
}

function open(db, device) {
  return transaction(db, () => {
    const expired = device.warranty_expires < currentDate(db);
    const ticket = createTicket(db, {
      title: `Warranty ${expired ? 'expired' : 'expiring'} ${device.warranty_expires}: ${device.name}`,
      body:
        `The manufacturer warranty on ${device.name} ` +
        `${expired ? 'lapsed on' : 'is due to lapse on'} ${device.warranty_expires}. ` +
        `Register a claim, renew it, or plan the replacement while it is still cheap to.`,
      priority: 'medium',
      device_id: device.id,
      due_date: device.warranty_expires,
      tags: ['warranty'],
    });

    db.prepare(`UPDATE devices SET warranty_notified_at = datetime('now') WHERE id = ?`).run(
      device.id,
    );

    return { device_id: device.id, ticket };
  });
}

/** SQLite's idea of today (UTC), so every date comparison uses one clock. */
const currentDate = (db) => db.prepare(`SELECT date('now') AS today`).get().today;
