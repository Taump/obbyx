import { DatabaseSync } from 'node:sqlite';
import { ObbyxError } from '@obbyx/obyte';
import { type Utxo, inputKey } from './selection.js';
import { immediateTransaction } from '../util/sqlite.js';

/** Durable (SQLite) reservations of the wallet's coins, bound to the unit that spends them. */
export interface ReservationRow {
  input_key: string;
  network: string;
  payment_unit: string | null;
  reserved_at: number;
}

export class CoinReservations {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS coin_reservations (
        input_key TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        address TEXT NOT NULL,
        payment_unit TEXT,
        reserved_at INTEGER NOT NULL,
        hold_until INTEGER
      ) STRICT;
    `);
    // Databases created before hold_until existed.
    const columns = this.db.prepare('PRAGMA table_info(coin_reservations)').all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === 'hold_until')) {
      this.db.exec('ALTER TABLE coin_reservations ADD COLUMN hold_until INTEGER');
    }
  }

  close(): void {
    this.db.close();
  }

  reservedKeys(network: string): Set<string> {
    const rows = this.db
      .prepare('SELECT input_key FROM coin_reservations WHERE network = ?')
      .all(network) as unknown as {
      input_key: string;
    }[];
    return new Set(rows.map((r) => r.input_key));
  }

  /** Reserves all inputs atomically; fails if any is already reserved. */
  reserve(network: string, address: string, inputs: readonly Utxo[]): void {
    const ts = this.now();
    try {
      immediateTransaction(this.db, () => {
        const insert = this.db.prepare(
          'INSERT INTO coin_reservations (input_key, network, address, payment_unit, reserved_at) VALUES (?, ?, ?, NULL, ?)',
        );
        for (const u of inputs) insert.run(inputKey(network, u), network, address, ts);
      });
    } catch (err) {
      throw new ObbyxError('coins_reserved', 'An input is already reserved by another payment', {
        cause: err,
      });
    }
  }

  /**
   * Binds the inputs reserved for a compose to the resulting unit hash.
   * `holdUntil`: the unit may still be published until then (offer validity +
   * the facilitator's publication window), so its inputs are never released earlier.
   */
  bind(network: string, inputs: readonly Utxo[], unit: string, holdUntil?: number): void {
    const update = this.db.prepare(
      'UPDATE coin_reservations SET payment_unit = ?, hold_until = ? WHERE input_key = ? AND payment_unit IS NULL',
    );
    for (const u of inputs) update.run(unit, holdUntil ?? null, inputKey(network, u));
  }

  /** Releases inputs whose compose failed (no unit was produced). */
  releaseUnbound(network: string, inputs: readonly Utxo[]): void {
    const del = this.db.prepare(
      'DELETE FROM coin_reservations WHERE input_key = ? AND payment_unit IS NULL',
    );
    for (const u of inputs) del.run(inputKey(network, u));
  }

  /** Units with live reservations, oldest first. */
  boundUnits(network: string): { unit: string; reservedAt: number; holdUntil: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT payment_unit, MIN(reserved_at) AS reserved_at, MAX(hold_until) AS hold_until
           FROM coin_reservations
          WHERE network = ? AND payment_unit IS NOT NULL GROUP BY payment_unit ORDER BY reserved_at`,
      )
      .all(network) as unknown as {
      payment_unit: string;
      reserved_at: number;
      hold_until: number | null;
    }[];
    return rows.map((r) => ({
      unit: r.payment_unit,
      reservedAt: r.reserved_at,
      holdUntil: r.hold_until,
    }));
  }

  /** Ends all reservations of a unit (seen on the ledger, or provably never published). */
  endUnit(network: string, unit: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM coin_reservations WHERE network = ? AND payment_unit = ?')
        .run(network, unit).changes,
    );
  }

  /** Drops reservations of composes that crashed before producing a unit. */
  dropStaleUnbound(network: string, olderThan: number): number {
    return Number(
      this.db
        .prepare(
          'DELETE FROM coin_reservations WHERE network = ? AND payment_unit IS NULL AND reserved_at < ?',
        )
        .run(network, olderThan).changes,
    );
  }

  rows(): ReservationRow[] {
    return this.db
      .prepare('SELECT input_key, network, payment_unit, reserved_at FROM coin_reservations')
      .all() as unknown as ReservationRow[];
  }
}
