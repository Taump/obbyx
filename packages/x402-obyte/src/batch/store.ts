import type { DatabaseSync } from 'node:sqlite';
import { ObbyxError } from '@obbyx/obyte';
import { immediateTransaction } from '../util/sqlite.js';

/**
 * Facilitator-side storage for `batch-settlement` (ADR-0003), sharing the
 * facilitator's SQLite connection (one process per database file).
 *
 * - `batch_channels`: per (network, aa) the committed cumulative amount for the
 *   current period and at most ONE pending commitment (serialization, MVP).
 * - `batch_commitments`: the journal. `seq` is global and monotonic; the seller's
 *   watcher reads it by cursor. An entry is `pending` until the watcher signed
 *   that it durably stored it (ack → `committed`) or that it refuses it
 *   (nack → `cancelled`, the channel is free again). Both are final.
 *
 * Amounts are decimal strings (BigInt in code).
 */
export interface ChannelRow {
  readonly key: string;
  readonly network: string;
  readonly aa: string;
  readonly payTo: string;
  readonly payer: string;
  readonly asset: string;
  readonly period: number;
  readonly committed: bigint;
  readonly pendingSeq: number | null;
}

export type CommitmentState = 'pending' | 'committed' | 'cancelled';

/** Who may settle a journal entry: the seller's watcher, for exactly this package. */
export interface CommitmentOwner {
  readonly payTo: string;
  readonly network: string;
  /** The packageHash the watcher signed in its receipt. */
  readonly packageHash: string;
}

/** A journal entry without its package: all that the checks and answers need. */
export interface CommitmentMeta {
  readonly seq: number;
  readonly channelKey: string;
  readonly network: string;
  readonly aa: string;
  readonly payTo: string;
  readonly period: number;
  readonly amountSpent: bigint;
  readonly paymentAmount: bigint;
  readonly binding: string;
  readonly packageHash: string;
  readonly state: CommitmentState;
}

export interface CommitmentRow extends CommitmentMeta {
  /** The signed package (decrypted on read by stores that encrypt it). */
  readonly packageJson: string;
}

export type AppendResult =
  | { ok: true; commitment: CommitmentRow }
  | {
      ok: false;
      reason: 'channel_busy' | 'cumulative_amount_mismatch' | 'period_mismatch';
      committed: bigint;
    };

export interface AppendInput {
  channelKey: string;
  network: string;
  aa: string;
  payTo: string;
  payer: string;
  asset: string;
  period: number;
  amountSpent: bigint;
  paymentAmount: bigint;
  binding: string;
  packageHash: string;
  packageJson: string;
}

/** Port for batch-settlement storage (node:sqlite here, Prisma in apps/facilitator). */
export interface BatchStore {
  channel(key: string): Promise<ChannelRow | undefined>;
  commitmentByHash(packageHash: string): Promise<CommitmentRow | undefined>;
  /** The entry of a package without the package itself (no decryption, no `package_read` event). */
  commitmentMeta(packageHash: string): Promise<CommitmentMeta | undefined>;
  commitment(seq: number): Promise<CommitmentRow | undefined>;
  journal(payTo: string, cursor: number, limit?: number): Promise<CommitmentRow[]>;
  /**
   * Every still-pending entry of a seller, whatever its seq: on reconnect they
   * are re-delivered even if the watcher's cursor is past them (stored but the
   * ack was lost, or stored out of order) — otherwise they would stay pending
   * forever and block their channels.
   */
  pending(payTo: string): Promise<CommitmentRow[]>;
  /** Atomically: check the channel is free and the cumulative rule, append a pending entry. */
  appendPending(input: AppendInput): Promise<AppendResult>;
  /**
   * pending → committed (idempotent); releases the channel. Only for the
   * entry of `owner` (seller + network + the signed packageHash): a watcher can
   * never commit another seller's voucher, nor one it did not sign for.
   * Returns undefined if not owned; a cancelled entry is returned unchanged.
   */
  commit(seq: number, owner: CommitmentOwner): Promise<CommitmentMeta | undefined>;
  /**
   * pending → cancelled (idempotent); releases the channel. Same ownership
   * rule as commit. A committed entry is returned unchanged (never undone).
   */
  cancel(seq: number, owner: CommitmentOwner): Promise<CommitmentMeta | undefined>;
}

/** The entry belongs to `owner` (seller, network and the exact package). */
export function ownedBy(
  c: Pick<CommitmentRow, 'payTo' | 'network' | 'packageHash'>,
  owner: CommitmentOwner,
): boolean {
  return (
    c.payTo === owner.payTo && c.network === owner.network && c.packageHash === owner.packageHash
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batch_channels (
  key TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  aa TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  payer TEXT NOT NULL,
  asset TEXT NOT NULL,
  period INTEGER NOT NULL,
  committed TEXT NOT NULL,
  pending_seq INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS batch_commitments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  network TEXT NOT NULL,
  aa TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  period INTEGER NOT NULL,
  amount_spent TEXT NOT NULL,
  payment_amount TEXT NOT NULL,
  binding TEXT NOT NULL,
  package_hash TEXT NOT NULL UNIQUE,
  package_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS batch_commitments_seller ON batch_commitments(pay_to, seq);
`;

interface ChannelDbRow {
  key: string;
  network: string;
  aa: string;
  pay_to: string;
  payer: string;
  asset: string;
  period: number;
  committed: string;
  pending_seq: number | null;
}

interface CommitmentDbRow {
  seq: number;
  channel_key: string;
  network: string;
  aa: string;
  pay_to: string;
  period: number;
  amount_spent: string;
  payment_amount: string;
  binding: string;
  package_hash: string;
  package_json: string;
  state: CommitmentState;
}

export class SqliteBatchStore implements BatchStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    db.exec(SCHEMA);
  }

  async channel(key: string): Promise<ChannelRow | undefined> {
    return this.channelSync(key);
  }

  private channelSync(key: string): ChannelRow | undefined {
    const row = this.db.prepare('SELECT * FROM batch_channels WHERE key = ?').get(key) as
      ChannelDbRow | undefined;
    return row === undefined ? undefined : toChannel(row);
  }

  async commitmentByHash(packageHash: string): Promise<CommitmentRow | undefined> {
    const row = this.db
      .prepare('SELECT * FROM batch_commitments WHERE package_hash = ?')
      .get(packageHash) as CommitmentDbRow | undefined;
    return row === undefined ? undefined : toCommitment(row);
  }

  async commitmentMeta(packageHash: string): Promise<CommitmentMeta | undefined> {
    const row = this.db
      .prepare('SELECT * FROM batch_commitments WHERE package_hash = ?')
      .get(packageHash) as CommitmentDbRow | undefined;
    return row === undefined ? undefined : toMeta(row);
  }

  async commitment(seq: number): Promise<CommitmentRow | undefined> {
    return this.commitmentSync(seq);
  }

  private commitmentSync(seq: number): CommitmentRow | undefined {
    const row = this.db.prepare('SELECT * FROM batch_commitments WHERE seq = ?').get(seq) as
      CommitmentDbRow | undefined;
    return row === undefined ? undefined : toCommitment(row);
  }

  /** Journal for one seller after `cursor` (both pending and committed). */
  async pending(payTo: string): Promise<CommitmentRow[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM batch_commitments WHERE pay_to = ? AND state = 'pending' ORDER BY seq",
      )
      .all(payTo) as unknown as CommitmentDbRow[];
    return rows.map(toCommitment);
  }

  async journal(payTo: string, cursor: number, limit = 500): Promise<CommitmentRow[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM batch_commitments WHERE pay_to = ? AND seq > ? AND state != 'cancelled' ORDER BY seq LIMIT ?",
      )
      .all(payTo, cursor, limit) as unknown as CommitmentDbRow[];
    return rows.map(toCommitment);
  }

  /**
   * Appends a pending commitment if the channel is free and the cumulative
   * rule holds against the stored state; all in one IMMEDIATE transaction.
   * A new period (the channel was closed and reopened) resets `committed`.
   */
  async appendPending(input: AppendInput): Promise<AppendResult> {
    return immediateTransaction(this.db, () => {
      let channel = this.channelSync(input.channelKey);
      const ts = this.now();
      if (channel === undefined || channel.period < input.period) {
        if (channel?.pendingSeq != null) {
          return {
            ok: false as const,
            reason: 'channel_busy' as const,
            committed: channel.committed,
          };
        }
        this.db
          .prepare(
            `INSERT INTO batch_channels (key, network, aa, pay_to, payer, asset, period, committed, pending_seq, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '0', NULL, ?)
             ON CONFLICT(key) DO UPDATE SET period = excluded.period, committed = '0', updated_at = excluded.updated_at`,
          )
          .run(
            input.channelKey,
            input.network,
            input.aa,
            input.payTo,
            input.payer,
            input.asset,
            input.period,
            ts,
          );
        channel = this.channelSync(input.channelKey);
      }
      if (channel === undefined) throw new ObbyxError('store_inconsistent', 'channel row missing');
      if (channel.period !== input.period) {
        return {
          ok: false as const,
          reason: 'period_mismatch' as const,
          committed: channel.committed,
        };
      }
      if (channel.pendingSeq !== null) {
        return {
          ok: false as const,
          reason: 'channel_busy' as const,
          committed: channel.committed,
        };
      }
      if (input.amountSpent !== channel.committed + input.paymentAmount) {
        return {
          ok: false as const,
          reason: 'cumulative_amount_mismatch' as const,
          committed: channel.committed,
        };
      }
      const res = this.db
        .prepare(
          `INSERT INTO batch_commitments
            (channel_key, network, aa, pay_to, period, amount_spent, payment_amount, binding, package_hash,
             package_json, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          input.channelKey,
          input.network,
          input.aa,
          input.payTo,
          input.period,
          input.amountSpent.toString(),
          input.paymentAmount.toString(),
          input.binding,
          input.packageHash,
          input.packageJson,
          ts,
        );
      const seq = Number(res.lastInsertRowid);
      this.db
        .prepare('UPDATE batch_channels SET pending_seq = ?, updated_at = ? WHERE key = ?')
        .run(seq, ts, input.channelKey);
      const commitment = this.commitmentSync(seq);
      if (commitment === undefined)
        throw new ObbyxError('store_inconsistent', 'commitment missing');
      return { ok: true as const, commitment };
    });
  }

  /** Watcher acked `seq` (durably stored): pending → committed. Idempotent. */
  async commit(seq: number, owner: CommitmentOwner): Promise<CommitmentRow | undefined> {
    return this.settle(seq, owner, 'committed');
  }

  /** Watcher nacked `seq` (refused, not stored): pending → cancelled. Idempotent. */
  async cancel(seq: number, owner: CommitmentOwner): Promise<CommitmentRow | undefined> {
    return this.settle(seq, owner, 'cancelled');
  }

  /**
   * pending → `to` for the entry of `owner`, releasing its channel; a commit
   * also advances the channel's committed amount. A final entry is returned
   * unchanged, a foreign one is undefined.
   */
  private settle(
    seq: number,
    owner: CommitmentOwner,
    to: 'committed' | 'cancelled',
  ): CommitmentRow | undefined {
    return immediateTransaction(this.db, () => {
      const c = this.commitmentSync(seq);
      if (c === undefined || !ownedBy(c, owner)) return undefined;
      if (c.state !== 'pending') return c;
      const ts = this.now();
      if (to === 'committed') {
        this.db
          .prepare(
            "UPDATE batch_commitments SET state = 'committed', committed_at = ? WHERE seq = ?",
          )
          .run(ts, seq);
        this.db
          .prepare(
            `UPDATE batch_channels SET committed = ?, pending_seq = NULL, updated_at = ?
              WHERE key = ? AND pending_seq = ? AND period = ?`,
          )
          .run(c.amountSpent.toString(), ts, c.channelKey, seq, c.period);
      } else {
        this.db.prepare("UPDATE batch_commitments SET state = 'cancelled' WHERE seq = ?").run(seq);
        this.db
          .prepare(
            'UPDATE batch_channels SET pending_seq = NULL, updated_at = ? WHERE key = ? AND pending_seq = ?',
          )
          .run(ts, c.channelKey, seq);
      }
      return this.commitmentSync(seq);
    });
  }
}

function toChannel(r: ChannelDbRow): ChannelRow {
  return {
    key: r.key,
    network: r.network,
    aa: r.aa,
    payTo: r.pay_to,
    payer: r.payer,
    asset: r.asset,
    period: r.period,
    committed: BigInt(r.committed),
    pendingSeq: r.pending_seq,
  };
}

function toCommitment(r: CommitmentDbRow): CommitmentRow {
  return { ...toMeta(r), packageJson: r.package_json };
}

function toMeta(r: CommitmentDbRow): CommitmentMeta {
  return {
    seq: r.seq,
    channelKey: r.channel_key,
    network: r.network,
    aa: r.aa,
    payTo: r.pay_to,
    period: r.period,
    amountSpent: BigInt(r.amount_spent),
    paymentAmount: BigInt(r.payment_amount),
    binding: r.binding,
    packageHash: r.package_hash,
    state: r.state,
  };
}
