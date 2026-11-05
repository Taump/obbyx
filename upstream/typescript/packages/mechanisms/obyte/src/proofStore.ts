/**
 * Resource-server registry of payments, so that one payment serves one
 * request. A settled `exact` payment is idempotent at the facilitator (a retry
 * of the same unit answers success again), so the server must remember which
 * payments already served a request.
 *
 *   settling → serving → served
 *       ↑         │
 *       └─────────┘ (settle not final, failed, or the handler failed)
 */
export type ObyteProofState = "settling" | "serving" | "served";

/** A registered payment. */
export interface ObyteProofRecord {
  readonly key: string;
  /** The binding of the operation this payment belongs to. */
  readonly binding: string;
  readonly state: ObyteProofState;
  readonly updatedAt: number;
}

/**
 * Storage of the payment registry. Several server processes must share one
 * implementation whose `begin` and `transition` are atomic.
 */
export interface ObyteProofStore {
  get(key: string): Promise<ObyteProofRecord | undefined>;
  /** Registers a payment in `settling` unless it is known; returns the stored record. */
  begin(key: string, binding: string): Promise<ObyteProofRecord>;
  /** Compare-and-set; true when the record was in `from`. */
  transition(key: string, from: ObyteProofState, to: ObyteProofState): Promise<boolean>;
  /** Moves a record stuck in `serving` for longer than `leaseSeconds` back to `settling`. */
  reclaimStale(key: string, leaseSeconds: number): Promise<void>;
}

/**
 * Process-local payment registry, the default (tests, a single process).
 * Records are never evicted; a long-running server should supply a durable
 * store with retention longer than the offer lifetime.
 */
export class InMemoryObyteProofStore implements ObyteProofStore {
  private readonly records = new Map<string, ObyteProofRecord>();
  private readonly now: () => number;

  /**
   * Creates an empty registry.
   *
   * @param now - Clock in unix seconds.
   */
  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  /**
   * Reads a record.
   *
   * @param key - Payment key.
   * @returns The record, if any.
   */
  async get(key: string): Promise<ObyteProofRecord | undefined> {
    return this.records.get(key);
  }

  /**
   * Registers a payment unless it is known.
   *
   * @param key - Payment key.
   * @param binding - Binding of the operation.
   * @returns The stored record.
   */
  async begin(key: string, binding: string): Promise<ObyteProofRecord> {
    const existing = this.records.get(key);
    if (existing !== undefined) return existing;
    const record: ObyteProofRecord = { key, binding, state: "settling", updatedAt: this.now() };
    this.records.set(key, record);
    return record;
  }

  /**
   * Compare-and-set transition.
   *
   * @param key - Payment key.
   * @param from - Required current state.
   * @param to - New state.
   * @returns True when it moved.
   */
  async transition(key: string, from: ObyteProofState, to: ObyteProofState): Promise<boolean> {
    const current = this.records.get(key);
    if (current === undefined || current.state !== from) return false;
    this.records.set(key, { ...current, state: to, updatedAt: this.now() });
    return true;
  }

  /**
   * Releases a `serving` claim older than the lease (its process died).
   *
   * @param key - Payment key.
   * @param leaseSeconds - Lease length.
   * @returns Nothing.
   */
  async reclaimStale(key: string, leaseSeconds: number): Promise<void> {
    const current = this.records.get(key);
    if (current?.state === "serving" && this.now() - current.updatedAt > leaseSeconds) {
      this.records.set(key, { ...current, state: "settling", updatedAt: this.now() });
    }
  }
}
