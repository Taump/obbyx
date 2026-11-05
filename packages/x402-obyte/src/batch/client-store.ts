import { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../util/sqlite.js';

/**
 * Buyer-side channel state (node:sqlite, lightweight; used by the SDK/CLI).
 *
 * Per channel: the AA params, the current period, the last amount the
 * facilitator confirmed (`committed`) and at most ONE pending voucher whose
 * outcome is unknown. While a voucher is pending, no new voucher is signed
 * (invariant I7); retrying the same operation resends the same voucher.
 *
 * `maxSigned` is the highest amount_spent we ever SIGNED in the current
 * period. It is never lowered by the seller's (unauthenticated) answers: on
 * close we must declare at least it, otherwise the holder of that voucher can
 * submit a fraud proof and the AA pays them the WHOLE channel.
 */
export interface ClientChannel {
  readonly network: string;
  readonly aa: string;
  readonly payTo: string;
  readonly asset: string;
  readonly timeout: number;
  readonly salt: string;
  readonly period: number;
  readonly committed: bigint;
  /** Highest amount signed in `period` (≥ committed); declare this on close. */
  readonly maxSigned: bigint;
  readonly pending: PendingVoucher | null;
  readonly openedUnit: string | null;
}

export interface PendingVoucher {
  readonly binding: string;
  readonly period: number;
  readonly amountSpent: string;
  readonly signedPackage: Record<string, unknown>;
}

interface Row {
  network: string;
  aa: string;
  pay_to: string;
  asset: string;
  timeout: number;
  salt: string;
  period: number;
  committed: string;
  max_signed: string;
  pending_json: string | null;
  opened_unit: string | null;
}

export class ClientChannelStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS client_channels (
        aa TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        asset TEXT NOT NULL,
        timeout INTEGER NOT NULL,
        salt TEXT NOT NULL,
        period INTEGER NOT NULL,
        committed TEXT NOT NULL,
        max_signed TEXT NOT NULL DEFAULT '0',
        pending_json TEXT,
        opened_unit TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    this.migrateMaxSigned();
  }

  /** Databases created before `max_signed`: add it, seeded from committed and the pending voucher. */
  private migrateMaxSigned(): void {
    const columns = this.db.prepare('PRAGMA table_info(client_channels)').all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === 'max_signed')) return;
    immediateTransaction(this.db, () => {
      this.db.exec("ALTER TABLE client_channels ADD COLUMN max_signed TEXT NOT NULL DEFAULT '0'");
      for (const row of this.db
        .prepare('SELECT * FROM client_channels')
        .all() as unknown as Row[]) {
        const pending =
          row.pending_json === null ? null : (JSON.parse(row.pending_json) as PendingVoucher);
        const signed =
          pending !== null && pending.period === row.period ? BigInt(pending.amountSpent) : 0n;
        this.setMaxSigned(row.aa, max(BigInt(row.committed), signed));
      }
    });
  }

  close(): void {
    this.db.close();
  }

  add(
    c: Omit<ClientChannel, 'pending' | 'committed' | 'maxSigned' | 'period'> & { period?: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO client_channels (aa, network, pay_to, asset, timeout, salt, period, committed, opened_unit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?) ON CONFLICT(aa) DO NOTHING`,
      )
      .run(
        c.aa,
        c.network,
        c.payTo,
        c.asset,
        c.timeout,
        c.salt,
        c.period ?? 1,
        c.openedUnit,
        Math.floor(Date.now() / 1000),
      );
  }

  get(aa: string): ClientChannel | undefined {
    const row = this.db.prepare('SELECT * FROM client_channels WHERE aa = ?').get(aa) as
      Row | undefined;
    return row === undefined ? undefined : toChannel(row);
  }

  /** The newest channel to `payTo` in `asset` on `network`. */
  find(network: string, payTo: string, asset: string): ClientChannel | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM client_channels WHERE network = ? AND pay_to = ? AND asset = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(network, payTo, asset) as Row | undefined;
    return row === undefined ? undefined : toChannel(row);
  }

  list(): ClientChannel[] {
    return (
      this.db.prepare('SELECT * FROM client_channels ORDER BY created_at').all() as unknown as Row[]
    ).map(toChannel);
  }

  /**
   * Records a signed voucher BEFORE it is sent (compare-and-set: fails if one
   * is pending) and raises `maxSigned` in the same transaction.
   */
  setPending(aa: string, pending: PendingVoucher): boolean {
    return immediateTransaction(this.db, () => {
      const res = this.db
        .prepare(
          'UPDATE client_channels SET pending_json = ? WHERE aa = ? AND pending_json IS NULL AND period = ?',
        )
        .run(JSON.stringify(pending), aa, pending.period);
      if (Number(res.changes) !== 1) return false;
      this.raiseMaxSigned(aa, BigInt(pending.amountSpent));
      return true;
    });
  }

  /** The facilitator confirmed `amountSpent` for `period`. */
  confirm(aa: string, period: number, amountSpent: bigint): void {
    immediateTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE client_channels SET period = ?, committed = ?, pending_json = NULL WHERE aa = ?',
        )
        .run(period, amountSpent.toString(), aa);
      this.raiseMaxSigned(aa, amountSpent);
    });
  }

  /** The voucher was definitely refused; optionally resync to the facilitator's committed amount. */
  dropPending(aa: string, resync?: { period: number; committed: bigint }): void {
    if (resync === undefined) {
      this.db.prepare('UPDATE client_channels SET pending_json = NULL WHERE aa = ?').run(aa);
    } else {
      this.db
        .prepare(
          'UPDATE client_channels SET pending_json = NULL, period = ?, committed = ? WHERE aa = ?',
        )
        .run(resync.period, resync.committed.toString(), aa);
    }
  }

  /** A new period started on-chain (the channel was closed and reopened). */
  newPeriod(aa: string, period: number): void {
    this.db
      .prepare(
        "UPDATE client_channels SET period = ?, committed = '0', max_signed = '0', pending_json = NULL WHERE aa = ? AND period < ?",
      )
      .run(period, aa, period);
  }

  private raiseMaxSigned(aa: string, amount: bigint): void {
    const row = this.db.prepare('SELECT max_signed FROM client_channels WHERE aa = ?').get(aa) as
      { max_signed: string } | undefined;
    if (row !== undefined && amount > BigInt(row.max_signed)) this.setMaxSigned(aa, amount);
  }

  private setMaxSigned(aa: string, amount: bigint): void {
    this.db
      .prepare('UPDATE client_channels SET max_signed = ? WHERE aa = ?')
      .run(amount.toString(), aa);
  }
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function toChannel(r: Row): ClientChannel {
  return {
    network: r.network,
    aa: r.aa,
    payTo: r.pay_to,
    asset: r.asset,
    timeout: r.timeout,
    salt: r.salt,
    period: r.period,
    committed: BigInt(r.committed),
    maxSigned: max(BigInt(r.committed), BigInt(r.max_signed)),
    pending: r.pending_json === null ? null : (JSON.parse(r.pending_json) as PendingVoucher),
    openedUnit: r.opened_unit,
  };
}
