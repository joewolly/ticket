import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { log, errorFields } from './log.js';

const PREFIX = 'homelab-';
const SUFFIX = '.db';

/** Matches only the files this module writes, so pruning cannot touch anything else. */
const BACKUP_NAME = /^homelab-\d{8}T\d{6}\.\d{3}Z\.db$/;

/**
 * Snapshots the database with VACUUM INTO, which is safe to run against a live
 * WAL database — unlike copying the file, which can capture a torn state.
 * Returns the file written, or null when backups are switched off.
 */
export async function runBackup(db, { dir, keep = 7 } = {}) {
  if (!dir) return null;

  await mkdir(dir, { recursive: true });

  const name = `${PREFIX}${new Date().toISOString().replace(/[-:]/g, '')}${SUFFIX}`;
  const target = join(dir, name);

  // VACUUM INTO takes no bound parameters, so the path is inlined. It is built
  // from a timestamp we generate, never from input, and quotes are doubled for
  // the SQL string literal regardless.
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

  const { size } = await stat(target);
  const pruned = await prune(dir, keep);

  log.info('backup written', { file: target, bytes: size, pruned: pruned.length });
  return { file: target, bytes: size, pruned };
}

/** Keeps the newest `keep` snapshots and deletes the rest. */
async function prune(dir, keep) {
  const names = (await readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort();
  const stale = names.slice(0, Math.max(0, names.length - keep));

  const removed = [];
  for (const name of stale) {
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch (err) {
      log.warn('could not prune backup', { file: name, ...errorFields(err) });
    }
  }
  return removed;
}

/**
 * Runs a backup without letting a failure reach the caller — the timer that
 * drives this must survive a full disk or a bad mount.
 */
export async function runBackupSafely(db, settings) {
  try {
    return await runBackup(db, settings);
  } catch (err) {
    log.error('backup failed', errorFields(err));
    return null;
  }
}
