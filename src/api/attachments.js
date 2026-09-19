import { NotFoundError, ValidationError, optionalText } from '../validate.js';
import { getTicket } from './tickets.js';

/**
 * Attachments are stored as BLOBs in the database rather than on a separate
 * disk, which keeps the app's central promise intact: there is still exactly
 * one file to back up, and a snapshot captures the photo of the failed drive
 * along with the ticket that explains it.
 *
 * The type allowlist is deliberately short. It is the set of things you
 * actually attach to a homelab ticket — a photo, a PDF invoice, a log file —
 * and nothing that a browser would run as markup, so serving a stored file back
 * can never turn into stored XSS.
 */
export const ALLOWED_TYPES = new Map([
  ['image/png', { ext: 'png', inline: true }],
  ['image/jpeg', { ext: 'jpg', inline: true }],
  ['image/gif', { ext: 'gif', inline: true }],
  ['image/webp', { ext: 'webp', inline: true }],
  ['application/pdf', { ext: 'pdf', inline: false }],
  ['text/plain', { ext: 'txt', inline: false }],
]);

/**
 * Stores an uploaded file against a ticket. `data` is the raw bytes as a
 * Buffer; the request layer has already enforced the size ceiling by refusing
 * to buffer anything larger.
 */
export function addAttachment(db, ticketId, { filename, contentType, data }) {
  getTicket(db, ticketId); // 404s if the ticket is gone

  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new ValidationError('Attachment body is empty');
  }

  const type = normalizeType(contentType);
  if (!ALLOWED_TYPES.has(type)) {
    throw new ValidationError(
      `Attachment type "${type}" is not allowed; accepted: ${[...ALLOWED_TYPES.keys()].join(', ')}`,
    );
  }

  const name = cleanFilename(filename, ALLOWED_TYPES.get(type).ext);

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO attachments (ticket_id, filename, content_type, size, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ticketId, name, type, data.length, data);

  db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticketId);

  return db
    .prepare('SELECT id, filename, content_type, size, created_at FROM attachments WHERE id = ?')
    .get(Number(lastInsertRowid));
}

/** The bytes plus what is needed to serve them, or a 404. */
export function getAttachment(db, id) {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`No attachment with id ${id}`);
  return row;
}

export function deleteAttachment(db, ticketId, id) {
  const row = db
    .prepare('SELECT 1 FROM attachments WHERE id = ? AND ticket_id = ?')
    .get(id, ticketId);
  if (!row) throw new NotFoundError(`No attachment with id ${id} on ticket ${ticketId}`);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  // Removing a file is activity on the ticket, the same as adding one.
  db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticketId);
}

/** Whether a stored type may be shown inline (images) or must be downloaded. */
export const isInline = (contentType) => ALLOWED_TYPES.get(contentType)?.inline ?? false;

/** Strips parameters and lowercases, so "image/PNG; charset=x" matches the map. */
function normalizeType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Reduces a client-supplied filename to a safe basename with a sensible
 * extension. Path separators and control characters are stripped so the stored
 * name can never be read as a path, and a name is always non-empty.
 */
function cleanFilename(filename, fallbackExt) {
  const raw = optionalText(filename, 'filename', 200) ?? '';
  const base = raw
    .replace(/[/\\]+/g, '_') // no path separators
    .replace(/[\x00-\x1f]/g, '') // no control characters
    .replace(/\.{2,}/g, '_') // no ".." traversal segments
    .replace(/^\.+/, '') // no leading dot (dotfiles)
    .trim();
  return base || `attachment.${fallbackExt}`;
}
