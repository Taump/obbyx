/**
 * Settlement state machine of the `exact` facilitator, one record per
 * (network, unit):
 *
 *   claimed → broadcasting → accepted → stable_good
 *                  │             └────→ final_bad
 *                  ├──→ rejected
 *                  └──→ expired
 *
 * The record is created (claimed) before the unit is broadcast, so a crash
 * between broadcast and the next write is recovered by re-driving
 * non-terminal records. Every transition is a compare-and-set.
 */
export type ObyteSettlementState =
  "claimed" | "broadcasting" | "accepted" | "stable_good" | "final_bad" | "rejected" | "expired";

/** States a settlement never leaves. */
export const TERMINAL_SETTLEMENT_STATES: ReadonlySet<ObyteSettlementState> = new Set([
  "stable_good",
  "final_bad",
  "rejected",
  "expired",
]);

/** A stored settlement. */
export interface ObyteSettlementRecord {
  readonly key: string;
  readonly network: string;
  readonly unitHash: string;
  readonly binding: string;
  readonly payer: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  readonly state: ObyteSettlementState;
  /** The signed unit, JSON. */
  readonly unitJson: string;
  /** After this time (unix seconds) an unpublished unit is never broadcast. */
  readonly publishDeadline: number;
  /** Broadcast attempts (counted before each post). */
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/** A settlement to claim. */
export type NewObyteSettlement = Omit<
  ObyteSettlementRecord,
  "state" | "attempts" | "lastError" | "updatedAt"
>;

/** Changes applied with a transition. */
export interface ObyteSettlementPatch {
  readonly lastError?: string;
  readonly incrementAttempts?: boolean;
}

/**
 * Storage of the settlement state machine. A facilitator with several
 * processes must supply a shared implementation whose `claim` and
 * `transition` are atomic (SQL, Redis, ...).
 */
export interface ObyteSettlementStore {
  get(key: string): Promise<ObyteSettlementRecord | undefined>;
  /** Creates the record unless it exists; returns the stored one. */
  claim(input: NewObyteSettlement): Promise<{ created: boolean; record: ObyteSettlementRecord }>;
  /** Moves the record from one of `from` to `to`; undefined when it was not in `from`. */
  transition(
    key: string,
    from: readonly ObyteSettlementState[],
    to: ObyteSettlementState,
    patch?: ObyteSettlementPatch,
  ): Promise<ObyteSettlementRecord | undefined>;
  /** Marks a non-terminal record as just looked at (fair rotation for recovery). */
  touch(key: string): Promise<void>;
  /** Non-terminal records, least recently looked at first. */
  listActive(limit?: number): Promise<ObyteSettlementRecord[]>;
}

/**
 * Process-local settlement store, the default. Suitable for tests and a
 * single-process facilitator; state is lost on restart, so a production
 * facilitator should supply a durable store.
 */
export class InMemoryObyteSettlementStore implements ObyteSettlementStore {
  private readonly records = new Map<string, ObyteSettlementRecord>();
  private readonly now: () => number;

  /**
   * Creates an empty store.
   *
   * @param now - Clock in unix seconds.
   */
  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  /**
   * Reads a record.
   *
   * @param key - Settlement key.
   * @returns The record, if any.
   */
  async get(key: string): Promise<ObyteSettlementRecord | undefined> {
    return this.records.get(key);
  }

  /**
   * Creates a record unless one exists.
   *
   * @param input - The settlement.
   * @returns Whether it was created, and the stored record.
   */
  async claim(
    input: NewObyteSettlement,
  ): Promise<{ created: boolean; record: ObyteSettlementRecord }> {
    const existing = this.records.get(input.key);
    if (existing !== undefined) return { created: false, record: existing };
    const record: ObyteSettlementRecord = {
      ...input,
      state: "claimed",
      attempts: 0,
      lastError: null,
      updatedAt: this.now(),
    };
    this.records.set(input.key, record);
    return { created: true, record };
  }

  /**
   * Compare-and-set transition.
   *
   * @param key - Settlement key.
   * @param from - Allowed current states.
   * @param to - New state.
   * @param patch - Changes applied with it.
   * @returns The new record, or undefined when the state did not match.
   */
  async transition(
    key: string,
    from: readonly ObyteSettlementState[],
    to: ObyteSettlementState,
    patch: ObyteSettlementPatch = {},
  ): Promise<ObyteSettlementRecord | undefined> {
    const current = this.records.get(key);
    if (current === undefined || !from.includes(current.state)) return undefined;
    const next: ObyteSettlementRecord = {
      ...current,
      state: to,
      attempts: current.attempts + (patch.incrementAttempts === true ? 1 : 0),
      lastError: patch.lastError ?? current.lastError,
      updatedAt: this.now(),
    };
    this.records.set(key, next);
    return next;
  }

  /**
   * Marks a record as just looked at.
   *
   * @param key - Settlement key.
   * @returns Nothing.
   */
  async touch(key: string): Promise<void> {
    const current = this.records.get(key);
    if (current !== undefined) this.records.set(key, { ...current, updatedAt: this.now() });
  }

  /**
   * Non-terminal records, least recently looked at first.
   *
   * @param limit - Maximum number of records.
   * @returns The records.
   */
  async listActive(limit = 100): Promise<ObyteSettlementRecord[]> {
    return [...this.records.values()]
      .filter(r => !TERMINAL_SETTLEMENT_STATES.has(r.state))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit);
  }
}
