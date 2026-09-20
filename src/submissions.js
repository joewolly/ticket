import { createHash } from 'node:crypto';
import { transaction } from './db.js';
import { ValidationError } from './validate.js';

/** Deduplication and resource writes share a transaction, including lost-response retries. */
export function submitOnce(db, scope, key, payload, create, read) {
  if (!key) return { value: create(), fresh: true };
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(key))
    throw new ValidationError('Invalid Idempotency-Key');
  const fingerprint = createHash('sha256').update(payload).digest('hex');
  return transaction(db, () => {
    const old = db
      .prepare('SELECT * FROM submissions WHERE scope = ? AND key = ?')
      .get(scope, key);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new ValidationError(
          'Submission already started with different content; restore the original draft or create a new one',
        );
      return { value: read(old.resource_id), fresh: false };
    }
    const value = create();
    db.prepare(
      'INSERT INTO submissions(scope,key,fingerprint,resource_id) VALUES (?,?,?,?)',
    ).run(scope, key, fingerprint, value.id);
    return { value, fresh: true };
  });
}
