import { DatabaseSync } from 'node:sqlite';
import { ObbyxError } from '@obbyx/obyte';
import { immediateTransaction } from '../util/sqlite.js';

/**
 * Settlement state machine storage for the `exact` scheme (ADR-0002, ADR-0005).
 *
 *   claimed → broadcasting → accepted → stable_good
 *                  │             └────→ final_bad
 *                  ├──→ rejected
 *                  └──→ expired
 *
 * - One row per (network, unit). The row is created (claimed) BEFORE the unit
 *   is broadcast (outbox), so a crash between broadcast and the next write is
 *   recovered by re-reading non-terminal rows on startup.
 * - Transitions are compare-and-set on the current state inside one
 *   SQLite transaction; a lost race returns `false` instead of overwriting.
 * - One facilitator process per database file: the connection takes an
 *   exclusive lock at open, so a second process fails fast.
 */
export type SettlementState =
  'claimed' | 'broadcasting' | 'accepted' | 'stable_good' | 'final_bad' | 'rejected' | 'expired';

export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set([
  'stable_good',
  'final_bad',
  'rejected',
  'expired',
]);

export interface SettlementRecord {
  readonly key: string;
  readonly network: string;
  readonly unitHash: string;
  readonly binding: string;
  readonly payer: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  readonly state: SettlementState;
  /** Signed unit JSON; deleted (null) after a terminal state and retention. */
  readonly unitJson: string | null;
  /** After this time (unix s) an unpublished unit is never broadcast. */
  readonly publishDeadline: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewSettlement {
  readonly key: string;
  readonly network: string;
  readonly unitHash: string;
  readonly binding: string;
  readonly payer: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  readonly unitJson: string;
  readonly publishDeadline: number;
}

export interface SettlementEvent {
  readonly key: string;
  readonly kind: string;
  readonly from?: SettlementState | null;
  readonly to?: SettlementState | null;
  readonly data?: Record<string, unknown>;
}

/**
 * Port for the `exact` settlement state machine (implemented with node:sqlite
 * here, and with Prisma in apps/facilitator). All implementations must pass
 * the shared contract tests: unique claim, compare-and-set transitions,
 * single process per database.
 */
export interface SettlementStore {
  get(key: string): Promise<SettlementRecord | undefined>;
  claim(input: NewSettlement): Promise<{ created: boolean; record: SettlementRecord }>;
  transition(
    key: string,
    from: readonly SettlementState[],
    to: SettlementState,
    patch?: TransitionPatch,
  ): Promise<SettlementRecord | undefined>;
  event(event: SettlementEvent): Promise<void>;
  listActive(limit?: number): Promise<SettlementRecord[]>;
  /** Marks a non-terminal record as just looked at (fair rotation in the recovery worker). */
  touch(key: string): Promise<void>;
  events(
    key: string,
  ): Promise<{ kind: string; from: string | null; to: string | null; data: unknown }[]>;
  pruneUnitBodies(olderThan: number): Promise<number>;
  close(): Promise<void>;
}

export interface TransitionPatch {
  readonly lastError?: string | null;
  readonly incrementAttempts?: boolean;
  readonly data?: Record<string, unknown>;
}

export class StoreLockedError extends ObbyxError {
  constructor(path: string, cause: unknown) {
    super(
      'store_locked',
      `Database ${path} is in use by another facilitator process (one instance per database file)`,
      { cause, details: { path } },
    );
  }
}

interface Row {
  key: string;
  network: string;
  unit_hash: string;
  binding: string;
  payer: string;
  pay_to: string;
  asset: string;
  amount: string;
  state: SettlementState;
  unit_json: string | null;
  publish_deadline: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exact_settlements (
  key TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  unit_hash TEXT NOT NULL,
  binding TEXT NOT NULL,
  payer TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  unit_json TEXT,
  publish_deadline INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS exact_settlements_active ON exact_settlements(state)
  WHERE state IN ('claimed', 'broadcasting', 'accepted');
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  data TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS events_key ON events(key);
`;

export class SqliteSettlementStore implements SettlementStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /**
   * @param path SQLite file, or `:memory:` for tests.
   * @param now  Clock in unix seconds (injectable for tests).
   */
  constructor(path: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 0');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      // Exclusive lock for the lifetime of the connection: a second process
      // fails on its first write instead of racing us.
      this.db.exec('PRAGMA locking_mode = EXCLUSIVE');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(SCHEMA);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.close();
      if (isBusy(err)) throw new StoreLockedError(path, err);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** The exclusive connection, shared with other facilitator stores (e.g. BatchStore). */
  get database(): DatabaseSync {
    return this.db;
  }

  async get(key: string): Promise<SettlementRecord | undefined> {
    return this.getSync(key);
  }

  private getSync(key: string): SettlementRecord | undefined {
    const row = this.db.prepare('SELECT * FROM exact_settlements WHERE key = ?').get(key) as
      Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Inserts a new settlement in state `claimed` unless the key exists.
   * Returns the stored record and whether this call created it.
   */
  async claim(input: NewSettlement): Promise<{ created: boolean; record: SettlementRecord }> {
    return immediateTransaction(this.db, () => {
      const existing = this.getSync(input.key);
      if (existing !== undefined) return { created: false, record: existing };
      const ts = this.now();
      this.db
        .prepare(
          `INSERT INTO exact_settlements
            (key, network, unit_hash, binding, payer, pay_to, asset, amount, state, unit_json,
             publish_deadline, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 0, ?, ?)`,
        )
        .run(
          input.key,
          input.network,
          input.unitHash,
          input.binding,
          input.payer,
          input.payTo,
          input.asset,
          input.amount,
          input.unitJson,
          input.publishDeadline,
          ts,
          ts,
        );
      this.insertEvent({ key: input.key, kind: 'claimed', from: null, to: 'claimed' }, ts);
      return { created: true, record: this.mustGet(input.key) };
    });
  }

  /**
   * Compare-and-set transition. Returns the new record, or `undefined` if the
   * current state is not one of `from` (someone else moved it first).
   */
  async transition(
    key: string,
    from: readonly SettlementState[],
    to: SettlementState,
    patch: TransitionPatch = {},
  ): Promise<SettlementRecord | undefined> {
    return immediateTransaction(this.db, () => {
      const current = this.getSync(key);
      if (current === undefined || !from.includes(current.state)) return undefined;
      const ts = this.now();
      this.db
        .prepare(
          `UPDATE exact_settlements
             SET state = ?, last_error = ?, attempts = attempts + ?, updated_at = ?
           WHERE key = ? AND state = ?`,
        )
        .run(
          to,
          patch.lastError === undefined ? current.lastError : patch.lastError,
          patch.incrementAttempts === true ? 1 : 0,
          ts,
          key,
          current.state,
        );
      this.insertEvent(
        {
          key,
          kind: 'transition',
          from: current.state,
          to,
          ...(patch.data ? { data: patch.data } : {}),
        },
        ts,
      );
      return this.mustGet(key);
    });
  }

  /** Records a non-transition event (e.g. a retry) in the payment journal. */
  async event(event: SettlementEvent): Promise<void> {
    this.insertEvent(event, this.now());
  }

  /** Non-terminal settlements, oldest first — resumed by the recovery worker. */
  async touch(key: string): Promise<void> {
    this.db
      .prepare('UPDATE exact_settlements SET updated_at = ? WHERE key = ?')
      .run(this.now(), key);
  }

  async listActive(limit = 100): Promise<SettlementRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM exact_settlements
          WHERE state IN ('claimed', 'broadcasting', 'accepted')
          ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  async events(
    key: string,
  ): Promise<{ kind: string; from: string | null; to: string | null; data: unknown }[]> {
    const rows = this.db
      .prepare('SELECT kind, from_state, to_state, data FROM events WHERE key = ? ORDER BY id')
      .all(key) as unknown as {
      kind: string;
      from_state: string | null;
      to_state: string | null;
      data: string | null;
    }[];
    return rows.map((r) => ({
      kind: r.kind,
      from: r.from_state,
      to: r.to_state,
      data: r.data === null ? null : (JSON.parse(r.data) as unknown),
    }));
  }

  /** Drops signed unit bodies of terminal settlements older than `olderThan` (unix s). */
  async pruneUnitBodies(olderThan: number): Promise<number> {
    const res = this.db
      .prepare(
        `UPDATE exact_settlements SET unit_json = NULL
          WHERE unit_json IS NOT NULL AND updated_at < ?
            AND state IN ('stable_good', 'final_bad', 'rejected', 'expired')`,
      )
      .run(olderThan);
    return Number(res.changes);
  }

  private insertEvent(event: SettlementEvent, ts: number): void {
    this.db
      .prepare(
        'INSERT INTO events (ts, key, kind, from_state, to_state, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        ts,
        event.key,
        event.kind,
        event.from ?? null,
        event.to ?? null,
        event.data === undefined ? null : JSON.stringify(event.data),
      );
  }

  private mustGet(key: string): SettlementRecord {
    const record = this.getSync(key);
    if (record === undefined)
      throw new ObbyxError('store_inconsistent', `Missing settlement ${key}`);
    return record;
  }
}

function toRecord(row: Row): SettlementRecord {
  return {
    key: row.key,
    network: row.network,
    unitHash: row.unit_hash,
    binding: row.binding,
    payer: row.payer,
    payTo: row.pay_to,
    asset: row.asset,
    amount: row.amount,
    state: row.state,
    unitJson: row.unit_json,
    publishDeadline: row.publish_deadline,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(message);
}
