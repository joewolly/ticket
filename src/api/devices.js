import {
  DEVICE_TYPES,
  DEVICE_STATUSES,
  CLOSED_STATUSES,
  NotFoundError,
  ValidationError,
  oneOf,
  optionalText,
  requiredText,
} from '../validate.js';

const CLOSED_LIST = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

// Every device read carries its open-ticket count, which is what makes the
// inventory list actionable rather than just a spreadsheet.
const SELECT_DEVICE = `
  SELECT d.*,
         (SELECT COUNT(*) FROM tickets t
           WHERE t.device_id = d.id AND t.status NOT IN (${CLOSED_LIST})) AS open_tickets
    FROM devices d
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

export function getDevice(db, id) {
  const device = db.prepare(`${SELECT_DEVICE} WHERE d.id = ?`).get(id);
  if (!device) throw new NotFoundError(`No device with id ${id}`);
  return device;
}

export function createDevice(db, input = {}) {
  const fields = parseDevice(input, { partial: false });

  try {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO devices (name, type, status, hostname, ip_address, location, os, notes)
         VALUES (:name, :type, :status, :hostname, :ip_address, :location, :os, :notes)`,
      )
      .run(fields);
    return getDevice(db, Number(lastInsertRowid));
  } catch (err) {
    throw translateUniqueName(err, fields.name);
  }
}

export function updateDevice(db, id, input = {}) {
  getDevice(db, id); // 404s before we touch anything

  const fields = parseDevice(input, { partial: true });
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new ValidationError('No updatable fields provided');

  const assignments = keys.map((key) => `${key} = :${key}`).join(', ');
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
 * payload are returned, so a PATCH never clobbers untouched columns.
 */
function parseDevice(input, { partial }) {
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

  return fields;
}

function translateUniqueName(err, name) {
  if (err.message?.includes('UNIQUE') && err.message.includes('devices.name')) {
    return new ValidationError(`A device named "${name}" already exists`);
  }
  return err;
}
