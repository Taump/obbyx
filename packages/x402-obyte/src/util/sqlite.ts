import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs `fn` in one `BEGIN IMMEDIATE` transaction (the write lock is taken up
 * front, so check-then-write inside `fn` cannot interleave with another
 * writer); commits on return, rolls back and rethrows on error.
 */
export function immediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
