import { DatabaseSync } from 'node:sqlite';
import { CHANNEL_BASE_AA, ObbyxError } from '@obbyx/obyte';
import { immediateTransaction } from '../util/sqlite.js';

/**
 * Buyer-side channel state (node:sqlite, lightweight; used by the SDK/CLI).
 *
 * `client_channels`, one row per channel: the AA params, the current period,
 * the last amount the facilitator confirmed (`committed`) and at most ONE
 * pending voucher whose outcome is unknown. While a voucher is pending, no
 * new voucher is signed (invariant I7); retrying the same operation resends
 * the same voucher.
 *
 * `client_periods`, one row per (channel, period), never deleted:
 * - `max_signed`: the highest amount_spent ever SIGNED in that period, raised
 *   in the same transaction that records the voucher as pending, before it
 *   leaves the process. Neither the seller's (unauthenticated) answers nor a
 *   hub reporting another period can lower it. On close we must declare at
 *   least it, otherwise the holder of that voucher submits a fraud proof and
 *   the AA pays it the WHOLE channel.
 * - `migrated`: the period was recorded by an earlier version, which may have
 *   lost track of vouchers it signed (a recovered channel is uncertain for
 *   every period).
 * - `close_declared` / `close_state`: our close of that period ({@link CloseState}).
 *   Written BEFORE the close unit is broadcast; `setPending` refuses a
 *   period with a close, so no voucher above the declaration can ever be
 *   signed, by this process or another one sharing the database.
 *
 * The schema version is written to `PRAGMA user_version`; a database written
 * by a newer version is refused (older versions do not check it: never run
 * one on a database this version has written).
 */
export interface ClientChannel {
  readonly network: string;
  readonly aa: string;
  readonly payTo: string;
  readonly asset: string;
  readonly timeout: number;
  readonly salt: string;
  /** Base AA of the channel; only {@link CHANNEL_BASE_AA} channels are paid into. */
  readonly baseAa: string;
  /** On an earlier base AA: close / confirm only, never pay into it. */
  readonly legacy: boolean;
  readonly period: number;
  readonly committed: bigint;
  /** Highest amount signed in `period` (≥ committed). */
  readonly maxSigned: bigint;
  /** Why more than `maxSigned` may have been signed in `period` (closing it needs `declare` or `force`). */
  readonly uncertainty: Uncertainty | null;
  readonly pending: PendingVoucher | null;
  readonly openedUnit: string | null;
  /** A deposit was seen credited on-chain at least once. */
  readonly funded: boolean;
  /**
   * Our latest close (or one seen on-chain, `declared` null). It is over once
   * the chain shows a period after `lastClose.period`.
   */
  readonly lastClose: {
    readonly period: number;
    readonly declared: bigint | null;
    readonly state: CloseState;
  } | null;
}

/**
 * What became of our close unit: `prepared` (decided, never posted),
 * `unknown` (posted, no answer: it may have landed), `posted` (the hub
 * accepted it, or a close is seen on-chain), `rejected` (the hub definitely
 * rejected it).
 */
export type CloseState = 'prepared' | 'unknown' | 'posted' | 'rejected';

/** `migrated`: from a version that forgot vouchers; `recovered`: found on-chain by `recoverChannels`. */
export type Uncertainty = 'migrated' | 'recovered';

export interface PendingVoucher {
  readonly binding: string;
  readonly period: number;
  readonly amountSpent: string;
  readonly signedPackage: Record<string, unknown>;
  /**
   * The PAYMENT-SIGNATURE header carrying the voucher (the encoded payment
   * payload): retry the operation with it. Recorded with the voucher, then
   * replaced by the header the caller really sent.
   */
  readonly paymentHeader?: string;
}

export interface NewClientChannel {
  readonly network: string;
  readonly aa: string;
  readonly payTo: string;
  readonly asset: string;
  readonly timeout: number;
  readonly salt: string;
  readonly openedUnit: string | null;
  /** Defaults to {@link CHANNEL_BASE_AA}. */
  readonly baseAa?: string;
  readonly period?: number;
  /** Defaults to false. */
  readonly funded?: boolean;
  /** Found on-chain: what was signed on it is unknown, in every period. Defaults to false. */
  readonly recovered?: boolean;
}

interface Row {
  network: string;
  aa: string;
  pay_to: string;
  asset: string;
  timeout: number;
  salt: string;
  base_aa: string;
  period: number;
  committed: string;
  pending_json: string | null;
  opened_unit: string | null;
  funded: number;
  recovered: number;
  max_signed: string | null;
  migrated: number | null;
  close_period: number | null;
  close_declared: string | null;
  close_state: CloseState | null;
}

/** Written to `PRAGMA user_version` (0: the released schemas without it). */
const SCHEMA_VERSION = 1;

/** Base AA of channels recorded before the column existed (v1.1). */
const PRE_COLUMN_BASE_AA = '4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ';

/** A channel with its current period's row and its latest close. */
const SELECT = `SELECT c.*, p.max_signed, p.migrated, l.period AS close_period, l.close_declared, l.close_state
  FROM client_channels c
  LEFT JOIN client_periods p ON p.aa = c.aa AND p.period = c.period
  LEFT JOIN client_periods l ON l.aa = c.aa AND l.period =
    (SELECT MAX(period) FROM client_periods WHERE aa = c.aa AND close_state IS NOT NULL)`;

/** Raises a period's `max_signed` (amounts are safe integers). */
const RAISE_SIGNED = `INSERT INTO client_periods (aa, period, max_signed) VALUES (?, ?, ?)
  ON CONFLICT(aa, period) DO UPDATE SET max_signed = excluded.max_signed
    WHERE CAST(excluded.max_signed AS INTEGER) > CAST(max_signed AS INTEGER)`;

export class ClientChannelStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // Before anything writes to it (journal_mode does).
      schemaVersion(this.db, path);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `);
      // One immediate transaction: two processes cannot both migrate.
      immediateTransaction(this.db, () => this.migrate(path));
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private migrate(path: string): void {
    if (schemaVersion(this.db, path) === SCHEMA_VERSION) return;
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(client_channels)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_channels (
        aa TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        asset TEXT NOT NULL,
        timeout INTEGER NOT NULL,
        salt TEXT NOT NULL,
        base_aa TEXT NOT NULL,
        period INTEGER NOT NULL,
        committed TEXT NOT NULL,
        pending_json TEXT,
        opened_unit TEXT,
        funded INTEGER NOT NULL,
        recovered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE client_periods (
        aa TEXT NOT NULL,
        period INTEGER NOT NULL,
        max_signed TEXT NOT NULL DEFAULT '0',
        migrated INTEGER NOT NULL DEFAULT 0,
        close_declared TEXT,
        close_state TEXT,
        PRIMARY KEY (aa, period)
      ) STRICT;
    `);
    if (columns.size > 0) this.migrateUnversioned(columns.has('max_signed'));
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * A database of an unversioned release (v1.1 channels, broadcast and
   * funded). The current period is seeded from its `max_signed` (if any),
   * committed and the pending voucher, which can be BELOW what that version
   * really signed: it forgot refused vouchers, or reset `max_signed` when a
   * hub reported a later period. So the period is `migrated`: closing it
   * needs a decision.
   */
  private migrateUnversioned(hasMaxSigned: boolean): void {
    this.db.exec(`
      ALTER TABLE client_channels ADD COLUMN base_aa TEXT NOT NULL DEFAULT '${PRE_COLUMN_BASE_AA}';
      ALTER TABLE client_channels ADD COLUMN funded INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE client_channels ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
    `);
    const rows = this.db.prepare('SELECT * FROM client_channels').all() as unknown as (Row & {
      max_signed?: string;
    })[];
    const insert = this.db.prepare(
      'INSERT INTO client_periods (aa, period, max_signed, migrated) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      const pending = parsePending(row.pending_json);
      const signed = [
        BigInt(row.committed),
        BigInt(row.max_signed ?? 0),
        pending?.period === row.period ? BigInt(pending.amountSpent) : 0n,
      ].reduce(max);
      insert.run(row.aa, row.period, signed.toString(), 1);
    }
    if (hasMaxSigned) this.db.exec('ALTER TABLE client_channels DROP COLUMN max_signed');
  }

  close(): void {
    this.db.close();
  }

  /** Records a channel (no-op if it exists). Write it BEFORE broadcasting the open unit. */
  add(c: NewClientChannel): void {
    this.db
      .prepare(
        `INSERT INTO client_channels (aa, network, pay_to, asset, timeout, salt, base_aa, period, committed,
           opened_unit, funded, recovered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?) ON CONFLICT(aa) DO NOTHING`,
      )
      .run(
        c.aa,
        c.network,
        c.payTo,
        c.asset,
        c.timeout,
        c.salt,
        c.baseAa ?? CHANNEL_BASE_AA,
        c.period ?? 1,
        c.openedUnit,
        c.funded === true ? 1 : 0,
        c.recovered === true ? 1 : 0,
        Math.floor(Date.now() / 1000),
      );
  }

  /**
   * The open unit was definitely rejected: forget the channel, but only while
   * nothing was ever signed or deposited on it.
   */
  removeUnopened(aa: string): void {
    this.db
      .prepare(
        `DELETE FROM client_channels WHERE aa = ? AND funded = 0 AND pending_json IS NULL
           AND NOT EXISTS (SELECT 1 FROM client_periods WHERE aa = ?)`,
      )
      .run(aa, aa);
  }

  /** A deposit was seen credited on-chain. */
  markFunded(aa: string): void {
    this.db.prepare('UPDATE client_channels SET funded = 1 WHERE aa = ?').run(aa);
  }

  get(aa: string): ClientChannel | undefined {
    const row = this.db.prepare(`${SELECT} WHERE c.aa = ?`).get(aa) as Row | undefined;
    return row === undefined ? undefined : toChannel(row);
  }

  /**
   * Channels to `payTo` in `asset` on `network` that may be paid into (on
   * {@link CHANNEL_BASE_AA}), best first: funded ones before not-yet-funded
   * ones (an open whose outcome is unknown must not shadow a working
   * channel), newest first.
   */
  candidates(network: string, payTo: string, asset: string): ClientChannel[] {
    return (
      this.db
        .prepare(
          `${SELECT} WHERE c.network = ? AND c.pay_to = ? AND c.asset = ? AND c.base_aa = ?
             ORDER BY c.funded DESC, c.created_at DESC, c.rowid DESC`,
        )
        .all(network, payTo, asset, CHANNEL_BASE_AA) as unknown as Row[]
    ).map(toChannel);
  }

  /** The best of {@link candidates}. */
  find(network: string, payTo: string, asset: string): ClientChannel | undefined {
    return this.candidates(network, payTo, asset)[0];
  }

  list(): ClientChannel[] {
    return (
      this.db.prepare(`${SELECT} ORDER BY c.created_at, c.rowid`).all() as unknown as Row[]
    ).map(toChannel);
  }

  /**
   * Records a signed voucher BEFORE it is sent (compare-and-set: fails if one
   * is pending, if the period moved, if a close of the period was started or
   * the channel is not on the current base AA) and raises the period's
   * `maxSigned` in the same transaction.
   */
  setPending(aa: string, pending: PendingVoucher): boolean {
    return immediateTransaction(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE client_channels SET pending_json = ?
             WHERE aa = ? AND pending_json IS NULL AND period = ? AND base_aa = ?
               AND NOT EXISTS (SELECT 1 FROM client_periods
                 WHERE aa = ? AND period = ? AND close_state IS NOT NULL)`,
        )
        .run(JSON.stringify(pending), aa, pending.period, CHANNEL_BASE_AA, aa, pending.period);
      if (Number(res.changes) !== 1) return false;
      this.db.prepare(RAISE_SIGNED).run(aa, pending.period, pending.amountSpent);
      return true;
    });
  }

  /** Records the full payment header of the pending voucher `binding` of `aa`, as it was really sent. */
  attachPaymentHeader(aa: string, binding: string, header: string): void {
    this.db
      .prepare(
        `UPDATE client_channels SET pending_json = json_set(pending_json, '$.paymentHeader', ?)
           WHERE aa = ? AND json_extract(pending_json, '$.binding') = ?`,
      )
      .run(header, aa, binding);
  }

  /**
   * The facilitator confirmed `amountSpent` for the pending voucher `voucher`
   * (matched on its binding and period: a late answer about an older voucher
   * or period changes nothing). Returns false when nothing matched.
   */
  confirm(aa: string, voucher: VoucherRef, amountSpent: bigint): boolean {
    return immediateTransaction(this.db, () => {
      if (!this.clearPending(aa, voucher, amountSpent)) return false;
      this.db.prepare(RAISE_SIGNED).run(aa, voucher.period, amountSpent.toString());
      return true;
    });
  }

  /**
   * The pending voucher `voucher` was definitely refused; optionally resync
   * to the facilitator's committed amount. Matched like {@link confirm}.
   */
  dropPending(aa: string, voucher: VoucherRef, resyncCommitted?: bigint): boolean {
    return this.clearPending(aa, voucher, resyncCommitted);
  }

  private clearPending(aa: string, voucher: VoucherRef, committed: bigint | undefined): boolean {
    const res = this.db
      .prepare(
        `UPDATE client_channels SET pending_json = NULL, committed = COALESCE(?, committed)
           WHERE aa = ? AND period = ? AND json_extract(pending_json, '$.binding') = ?`,
      )
      .run(committed?.toString() ?? null, aa, voucher.period, voucher.binding);
    return Number(res.changes) === 1;
  }

  /**
   * Period `period` is seen on-chain. If it is later than ours (the channel
   * was closed), the pending voucher of the old period is void. The history
   * of older periods stays. Idempotent.
   */
  newPeriod(aa: string, period: number): void {
    this.db
      .prepare(
        `UPDATE client_channels SET period = ?, committed = '0', pending_json = NULL, funded = 1
           WHERE aa = ? AND period < ?`,
      )
      .run(period, aa, period);
  }

  /**
   * Starts closing period `period` (the ON-CHAIN one): in one immediate
   * transaction, decides the declaration and records the close, so no
   * voucher can be signed in that period any more (setPending refuses).
   * Call BEFORE broadcasting the close; declare the returned amount.
   *
   * The declaration is at least the highest amount signed in the period and
   * any earlier declaration of it that may have been sent (state other than
   * `prepared`). Without options, an earlier declaration of the period
   * stands (raised if needed); otherwise an uncertain period
   * ({@link ClientChannel.uncertainty}) needs `declare` (an explicit amount)
   * or `force` (the known amount).
   *
   * `previous` is the state of an earlier close of this period, `raised`
   * whether the declaration went above it.
   */
  beginClose(
    aa: string,
    period: number,
    options: { readonly declare?: bigint; readonly force?: boolean } = {},
  ): { declared: bigint; previous: CloseState | null; raised: boolean } {
    return immediateTransaction(this.db, () => {
      const channel = this.db
        .prepare('SELECT recovered FROM client_channels WHERE aa = ?')
        .get(aa) as { recovered: number } | undefined;
      if (channel === undefined) throw new ObbyxError('no_channel', `Unknown channel ${aa}`);
      this.newPeriod(aa, period);
      const row = this.db
        .prepare('SELECT * FROM client_periods WHERE aa = ? AND period = ?')
        .get(aa, period) as PeriodRow | undefined;
      const signed = BigInt(row?.max_signed ?? 0);
      const earlier =
        row?.close_declared == null
          ? null
          : { declared: BigInt(row.close_declared), state: row.close_state as CloseState };
      const floor =
        earlier !== null && earlier.state !== 'prepared' ? max(signed, earlier.declared) : signed;
      let declared: bigint;
      if (options.declare !== undefined) {
        if (options.declare < floor)
          throw new ObbyxError(
            'declare_too_low',
            `Period ${period} needs a declaration of at least ${floor} (signed ${signed}` +
              (floor > signed ? `, a close declaring ${floor} was already sent` : '') +
              `); declaring ${options.declare} would let the seller take the whole deposit`,
            { details: { floor: floor.toString(), signed: signed.toString() } },
          );
        declared = options.declare;
      } else if (earlier !== null && options.force !== true) {
        declared = max(earlier.declared, signed);
      } else {
        const uncertainty: Uncertainty | null =
          channel.recovered === 1 ? 'recovered' : row?.migrated === 1 ? 'migrated' : null;
        if (uncertainty !== null && options.force !== true)
          throw new ObbyxError(
            'max_signed_uncertain',
            `${UNCERTAIN_WHY[uncertainty](aa)}: the highest known for period ${period} is ${signed}, ` +
              'but more may have been signed. Declaring less than any signed voucher lets the seller take ' +
              'the WHOLE deposit. Pass --declare <amount> with an amount you are sure covers every voucher, ' +
              'or --force to declare the known amount.',
            { details: { known: signed.toString(), period, reason: uncertainty } },
          );
        declared = floor;
      }
      this.db
        .prepare(
          `INSERT INTO client_periods (aa, period, close_declared, close_state) VALUES (?, ?, ?, ?)
             ON CONFLICT(aa, period) DO UPDATE SET close_declared = excluded.close_declared,
               close_state = excluded.close_state`,
        )
        .run(aa, period, declared.toString(), earlier?.state ?? 'prepared');
      return {
        declared,
        previous: earlier?.state ?? null,
        raised: earlier !== null && declared > earlier.declared,
      };
    });
  }

  /**
   * Records what became of our close unit for `period`. A close seen
   * `posted` is never downgraded (it may land whatever a later attempt does).
   */
  setCloseState(aa: string, period: number, state: Exclude<CloseState, 'prepared'>): void {
    this.db
      .prepare(
        `UPDATE client_periods SET close_state = ?
           WHERE aa = ? AND period = ? AND close_declared IS NOT NULL AND close_state IS NOT 'posted'`,
      )
      .run(state, aa, period);
  }

  /**
   * The close of `period` declaring `declared` is about to be broadcast:
   * `unknown` from now on (a `posted` one stays `posted`). Compare-and-set:
   * false, and nothing may be broadcast, when the recorded declaration is no
   * longer `declared` (another process changed it meanwhile).
   */
  closeSent(aa: string, period: number, declared: bigint): boolean {
    const res = this.db
      .prepare(
        `UPDATE client_periods SET close_state = IIF(close_state = 'posted', 'posted', 'unknown')
           WHERE aa = ? AND period = ? AND close_declared = ?`,
      )
      .run(aa, period, declared.toString());
    return Number(res.changes) === 1;
  }

  /** The state of our close of `period` (or of one seen on-chain); undefined if none. */
  closeState(aa: string, period: number): CloseState | undefined {
    const row = this.db
      .prepare('SELECT close_state FROM client_periods WHERE aa = ? AND period = ?')
      .get(aa, period) as { close_state: CloseState | null } | undefined;
    return row?.close_state ?? undefined;
  }

  /** A close of `period` is pending on-chain (ours or the seller's): stop signing in it. */
  markClosing(aa: string, period: number): void {
    immediateTransaction(this.db, () => {
      this.newPeriod(aa, period);
      this.db
        .prepare(
          `INSERT INTO client_periods (aa, period, close_state) VALUES (?, ?, 'posted')
             ON CONFLICT(aa, period) DO UPDATE SET close_state = 'posted'`,
        )
        .run(aa, period);
    });
  }
}

type VoucherRef = Pick<PendingVoucher, 'binding' | 'period'>;

interface PeriodRow {
  max_signed: string;
  migrated: number;
  close_declared: string | null;
  close_state: CloseState | null;
}

const UNCERTAIN_WHY: Record<Uncertainty, (aa: string) => string> = {
  recovered: (aa) =>
    `Channel ${aa} was recovered from the chain: this database does not know what was signed on it elsewhere`,
  migrated: (aa) =>
    `Channel ${aa} was recorded by an older obbyx version, which may have lost track of vouchers it signed`,
};

/** The schema version of the database; refuses one written by a newer version. */
function schemaVersion(db: DatabaseSync, path: string): number {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version > SCHEMA_VERSION)
    throw new ObbyxError(
      'store_too_new',
      `The channel database ${path} was written by a newer obbyx version (schema ${version}, ` +
        `this one knows ${SCHEMA_VERSION}); downgrading is unsafe: upgrade obbyx`,
    );
  return version;
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function parsePending(json: string | null): PendingVoucher | null {
  return json === null ? null : (JSON.parse(json) as PendingVoucher);
}

function toChannel(r: Row): ClientChannel {
  return {
    network: r.network,
    aa: r.aa,
    payTo: r.pay_to,
    asset: r.asset,
    timeout: r.timeout,
    salt: r.salt,
    baseAa: r.base_aa,
    legacy: r.base_aa !== CHANNEL_BASE_AA,
    period: r.period,
    committed: BigInt(r.committed),
    maxSigned: max(BigInt(r.committed), BigInt(r.max_signed ?? 0)),
    uncertainty: r.recovered === 1 ? 'recovered' : r.migrated === 1 ? 'migrated' : null,
    pending: parsePending(r.pending_json),
    openedUnit: r.opened_unit,
    funded: r.funded === 1,
    lastClose:
      r.close_period === null || r.close_state === null
        ? null
        : {
            period: r.close_period,
            declared: r.close_declared === null ? null : BigInt(r.close_declared),
            state: r.close_state,
          },
  };
}
