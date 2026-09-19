import {
  DEVICE_TYPES,
  DEVICE_STATUSES,
  CLOSED_STATUSES,
  NotFoundError,
  ValidationError,
  oneOf,
  optionalDate,
  optionalId,
  optionalMoney,
  optionalText,
  requiredText,
} from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

// The correlated count of a device's unresolved tickets, shared by the device
// read and the dependents query so the two can never drift out of step.
const OPEN_TICKETS = `(SELECT COUNT(*) FROM tickets t
           WHERE t.device_id = d.id AND t.status NOT IN (${CLOSED_LIST}))`;

// Every device read carries its open-ticket count, which is what makes the
// inventory list actionable rather than just a spreadsheet, plus the name of
// the device it depends on so the list can hint at the topology.
const SELECT_DEVICE = `
  SELECT d.*,
         p.name AS parent_name,
         ${OPEN_TICKETS} AS open_tickets
    FROM devices d
    LEFT JOIN devices p ON p.id = d.parent_id
`;

export function listDevices(db, query = {}) {
  const where = [];
  const params = {};

  if (query.status) {
    where.push('d.status = :status');
    params.status = oneOf(query.status, DEVICE_STATUSES, 'status');
  }
  if (query.type) {
    where.push('d.type = :type');
    params.type = oneOf(query.type, DEVICE_TYPES, 'type');
  }
  if (query.q) {
    where.push('(d.name LIKE :q OR d.hostname LIKE :q OR d.ip_address LIKE :q OR d.location LIKE :q)');
    params.q = `%${query.q}%`;
  }

  const sql = `${SELECT_DEVICE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY open_tickets DESC, d.name COLLATE NOCASE ASC`;

  return db.prepare(sql).all(params);
}

/**
 * A device plus the machines that hang off it — the "if this is down, here is
 * what it takes with it" list you want in front of you before pulling power.
 */
export function getDevice(db, id) {
  const device = db.prepare(`${SELECT_DEVICE} WHERE d.id = ?`).get(id);
  if (!device) throw new NotFoundError(`No device with id ${id}`);

  const dependents = db
    .prepare(
      `SELECT d.id, d.name, d.type, d.status, ${OPEN_TICKETS} AS open_tickets
         FROM devices d WHERE d.parent_id = ?
        ORDER BY d.name COLLATE NOCASE ASC`,
    )
    .all(id);

  return { ...device, dependents };
}

export function createDevice(db, input = {}) {
  const fields = parseDevice(db, input, { partial: false });

  try {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO devices
           (name, type, status, hostname, ip_address, location, os, notes,
            serial_number, purchase_date, warranty_expires, cost, parent_id)
         VALUES
           (:name, :type, :status, :hostname, :ip_address, :location, :os, :notes,
            :serial_number, :purchase_date, :warranty_expires, :cost, :parent_id)`,
      )
      .run(fields);
    return getDevice(db, Number(lastInsertRowid));
  } catch (err) {
    throw translateUniqueName(err, fields.name);
  }
}

export function updateDevice(db, id, input = {}) {
  getDevice(db, id); // 404s before we touch anything

  const fields = parseDevice(db, input, { partial: true, id });
  if (Object.keys(fields).length === 0) throw new ValidationError('No updatable fields provided');

  // Editing the warranty date re-arms its expiry alert, the same way moving a
  // ticket's due date re-arms the overdue one.
  if (Object.hasOwn(fields, 'warranty_expires')) fields.warranty_notified_at = null;

  const assignments = Object.keys(fields).map((key) => `${key} = :${key}`).join(', ');
  try {
    db.prepare(
      `UPDATE devices SET ${assignments}, updated_at = datetime('now') WHERE id = :id`,
    ).run({ ...fields, id });
  } catch (err) {
    throw translateUniqueName(err, fields.name);
  }
  return getDevice(db, id);
}

/**
 * Deletes a device. Its tickets are kept — the history of a machine you no
 * longer own is often exactly what you want to look back on — and their
 * device_id is nulled by the schema's ON DELETE SET NULL.
 */
export function deleteDevice(db, id) {
  getDevice(db, id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

/**
 * Validates device input. With `partial: true` only the keys present in the
 * payload are returned, so a PATCH never clobbers untouched columns. `id` is
 * the device being edited, needed to keep a parent link from forming a cycle.
 */
function parseDevice(db, input, { partial, id = null }) {
  const fields = {};
  const has = (key) => Object.hasOwn(input, key);

  if (!partial || has('name')) fields.name = requiredText(input.name, 'name', 100);
  if (!partial || has('type')) fields.type = oneOf(input.type, DEVICE_TYPES, 'type', 'other');
  if (!partial || has('status')) {
    fields.status = oneOf(input.status, DEVICE_STATUSES, 'status', 'active');
  }
  if (!partial || has('hostname')) fields.hostname = optionalText(input.hostname, 'hostname', 253);
  if (!partial || has('ip_address')) fields.ip_address = optionalText(input.ip_address, 'ip_address', 45);
  if (!partial || has('location')) fields.location = optionalText(input.location, 'location', 100);
  if (!partial || has('os')) fields.os = optionalText(input.os, 'os', 100);
  if (!partial || has('notes')) fields.notes = optionalText(input.notes, 'notes', 5000);

  if (!partial || has('serial_number')) {
    fields.serial_number = optionalText(input.serial_number, 'serial_number', 100);
  }
  if (!partial || has('purchase_date')) {
    fields.purchase_date = optionalDate(input.purchase_date, 'purchase_date');
  }
  if (!partial || has('warranty_expires')) {
    fields.warranty_expires = optionalDate(input.warranty_expires, 'warranty_expires');
  }
  if (!partial || has('cost')) fields.cost = optionalMoney(input.cost, 'cost');

  if (!partial || has('parent_id')) {
    fields.parent_id = optionalId(input.parent_id, 'parent_id');
    if (fields.parent_id !== null) assertParentIsSafe(db, id, fields.parent_id);
  }

  return fields;
}

/**
 * A device may not be its own parent, may only point at one that exists, and
 * may not close a loop — A depends on B depends on A would make "what does this
 * take down?" recurse forever. The chain is walked upward from the proposed
 * parent; reaching the device being edited means the link would form a cycle.
 */
function assertParentIsSafe(db, id, parentId) {
  // Compare as a number: a string id from a direct caller would slip a strict
  // `===` self-check and let a device be made its own parent.
  const self = id === null ? null : Number(id);

  if (self !== null && parentId === self) {
    throw new ValidationError('A device cannot depend on itself');
  }
  if (!db.prepare('SELECT 1 FROM devices WHERE id = ?').get(parentId)) {
    throw new ValidationError(`No device with id ${parentId}`);
  }

  const step = db.prepare('SELECT parent_id FROM devices WHERE id = ?');
  const seen = new Set();
  let cursor = parentId;
  while (cursor !== null && cursor !== undefined) {
    if (cursor === self) {
      throw new ValidationError('That parent would create a dependency loop');
    }
    // A parent chain corrupted into a pre-existing cycle would otherwise loop
    // forever; stop the first time a device is seen twice.
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = step.get(cursor)?.parent_id ?? null;
  }
}

function translateUniqueName(err, name) {
  if (err.message?.includes('UNIQUE') && err.message.includes('devices.name')) {
    return new ValidationError(`A device named "${name}" already exists`);
  }
  return err;
}
