import { DatabaseSync } from 'node:sqlite';

/**
 * Buyer-side channel state (node:sqlite, lightweight; used by the SDK/CLI).
 *
 * Per channel: the AA params, the current period, the last amount the
 * facilitator confirmed (`committed`) and at most ONE pending voucher whose
 * outcome is unknown. While a voucher is pending, no new voucher is signed
 * (invariant I7); retrying the same operation resends the same voucher.
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
        pending_json TEXT,
        opened_unit TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  add(c: Omit<ClientChannel, 'pending' | 'committed' | 'period'> & { period?: number }): void {
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

  /** Records a signed voucher BEFORE it is sent (compare-and-set: fails if one is pending). */
  setPending(aa: string, pending: PendingVoucher): boolean {
    const res = this.db
      .prepare('UPDATE client_channels SET pending_json = ? WHERE aa = ? AND pending_json IS NULL')
      .run(JSON.stringify(pending), aa);
    return Number(res.changes) === 1;
  }

  /** The facilitator confirmed `amountSpent` for `period`. */
  confirm(aa: string, period: number, amountSpent: bigint): void {
    this.db
      .prepare(
        'UPDATE client_channels SET period = ?, committed = ?, pending_json = NULL WHERE aa = ?',
      )
      .run(period, amountSpent.toString(), aa);
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
        "UPDATE client_channels SET period = ?, committed = '0', pending_json = NULL WHERE aa = ? AND period < ?",
      )
      .run(period, aa, period);
  }
}

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
    pending: r.pending_json === null ? null : (JSON.parse(r.pending_json) as PendingVoucher),
    openedUnit: r.opened_unit,
  };
}
