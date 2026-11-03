import type { DatabaseSync } from 'node:sqlite';
import { ObbyxError } from '@obbyx/obyte';

/**
 * Facilitator-side storage for `batch-settlement` (ADR-0003), sharing the
 * facilitator's SQLite connection (one process per database file).
 *
 * - `batch_channels`: per (network, aa) the committed cumulative amount for the
 *   current period and at most ONE pending commitment (serialization, MVP).
 * - `batch_commitments`: the journal. `seq` is global and monotonic; the seller's
 *   watcher reads it by cursor. An entry is `pending` until the watcher has
 *   durably stored it (ack), then `committed`.
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

export type CommitmentState = 'pending' | 'committed';

export interface CommitmentRow {
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
  readonly packageJson: string;
  readonly state: CommitmentState;
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
  commitment(seq: number): Promise<CommitmentRow | undefined>;
  journal(payTo: string, cursor: number, limit?: number): Promise<CommitmentRow[]>;
  /** Atomically: check the channel is free and the cumulative rule, append a pending entry. */
  appendPending(input: AppendInput): Promise<AppendResult>;
  /**
   * pending → committed (idempotent); releases the channel. Only commits a
   * voucher of `owner` (seller + network): a watcher can never ack — and thus
   * commit — another seller's voucher. Returns undefined if not owned.
   */
  commit(
    seq: number,
    owner: { payTo: string; network: string },
  ): Promise<CommitmentRow | undefined>;
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

  async commitment(seq: number): Promise<CommitmentRow | undefined> {
    return this.commitmentSync(seq);
  }

  private commitmentSync(seq: number): CommitmentRow | undefined {
    const row = this.db.prepare('SELECT * FROM batch_commitments WHERE seq = ?').get(seq) as
      CommitmentDbRow | undefined;
    return row === undefined ? undefined : toCommitment(row);
  }

  /** Journal for one seller after `cursor` (both pending and committed). */
  async journal(payTo: string, cursor: number, limit = 500): Promise<CommitmentRow[]> {
    const rows = this.db
      .prepare('SELECT * FROM batch_commitments WHERE pay_to = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(payTo, cursor, limit) as unknown as CommitmentDbRow[];
    return rows.map(toCommitment);
  }

  /**
   * Appends a pending commitment if the channel is free and the cumulative
   * rule holds against the stored state; all in one IMMEDIATE transaction.
   * A new period (the channel was closed and reopened) resets `committed`.
   */
  async appendPending(input: AppendInput): Promise<AppendResult> {
    return this.tx(() => {
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
  async commit(
    seq: number,
    owner: { payTo: string; network: string },
  ): Promise<CommitmentRow | undefined> {
    return this.tx(() => {
      const c = this.commitmentSync(seq);
      if (c === undefined || c.payTo !== owner.payTo || c.network !== owner.network)
        return undefined;
      if (c.state === 'committed') return c;
      const ts = this.now();
      this.db
        .prepare("UPDATE batch_commitments SET state = 'committed', committed_at = ? WHERE seq = ?")
        .run(ts, seq);
      this.db
        .prepare(
          `UPDATE batch_channels SET committed = ?, pending_seq = NULL, updated_at = ?
            WHERE key = ? AND pending_seq = ? AND period = ?`,
        )
        .run(c.amountSpent.toString(), ts, c.channelKey, seq, c.period);
      return this.commitmentSync(seq);
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
    packageJson: r.package_json,
    state: r.state,
  };
}
