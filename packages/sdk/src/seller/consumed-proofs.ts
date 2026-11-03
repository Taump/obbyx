import { DatabaseSync } from 'node:sqlite';

/**
 * Seller-side registry of consumed payment proofs (invariant I3).
 *
 * Keyed by `<caip2>:unit:<hash>`, so it holds even when several APIs or
 * facilitators serve the same payTo. Each proof serves exactly one operation
 * (its binding); a repeat of that operation gets the stored response.
 *
 *   upfront:       settling → paid_not_served → serving → served
 *                      └────→ failed                 └──→ paid_not_served (handler failed)
 *   authorization: settling → serving → awaiting_settle → served
 *                                 │              └──────→ failed (handler already ran)
 *                                 └──→ settling (handler failed; nothing settled)
 *
 *   serving older than the lease (crash) → paid_not_served | settling (reclaimStale)
 *
 * Transitions are compare-and-set, so concurrent requests with the same proof
 * never run the handler twice.
 */
export type ProofState =
  | 'settling'
  | 'paid_not_served'
  | 'serving'
  | 'served'
  | 'failed'
  /** authorization flow: the handler ran, its response waits for the settlement. */
  | 'awaiting_settle';

export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ProofRecord {
  readonly key: string;
  readonly binding: string;
  readonly state: ProofState;
  readonly paymentResponse: string | null;
  readonly response: StoredResponse | null;
  readonly updatedAt: number;
}

interface Row {
  key: string;
  binding: string;
  state: ProofState;
  payment_response: string | null;
  response_status: number | null;
  response_headers: string | null;
  response_body: Uint8Array | null;
  updated_at: number;
}

export class ConsumedProofsStore {
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
      CREATE TABLE IF NOT EXISTS consumed_proofs (
        key TEXT PRIMARY KEY,
        binding TEXT NOT NULL,
        state TEXT NOT NULL,
        payment_response TEXT,
        response_status INTEGER,
        response_headers TEXT,
        response_body BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payment_ids (
        scope_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        proof_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  /**
   * x402 `payment-identifier`: remembers which proof served a client-chosen id
   * for one operation fingerprint. Returns the stored mapping (existing or new).
   */
  bindPaymentId(
    scopeId: string,
    fingerprint: string,
    proofKey: string,
  ): { fingerprint: string; proofKey: string; created: boolean } {
    const res = this.db
      .prepare(
        'INSERT INTO payment_ids (scope_id, fingerprint, proof_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id) DO NOTHING',
      )
      .run(scopeId, fingerprint, proofKey, this.now());
    const row = this.db
      .prepare('SELECT fingerprint, proof_key FROM payment_ids WHERE scope_id = ?')
      .get(scopeId) as {
      fingerprint: string;
      proof_key: string;
    };
    return {
      fingerprint: row.fingerprint,
      proofKey: row.proof_key,
      created: Number(res.changes) === 1,
    };
  }

  /** Compare-and-set: moves the id only if it still points at `previous` (one winner). */
  rebindPaymentId(scopeId: string, previous: string, proofKey: string): boolean {
    const res = this.db
      .prepare('UPDATE payment_ids SET proof_key = ? WHERE scope_id = ? AND proof_key = ?')
      .run(proofKey, scopeId, previous);
    return Number(res.changes) === 1;
  }

  close(): void {
    this.db.close();
  }

  get(key: string): ProofRecord | undefined {
    const row = this.db.prepare('SELECT * FROM consumed_proofs WHERE key = ?').get(key) as
      Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Inserts the proof in `settling` unless it exists; returns the stored record. */
  begin(key: string, binding: string): { created: boolean; record: ProofRecord } {
    const ts = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO consumed_proofs (key, binding, state, created_at, updated_at)
         VALUES (?, ?, 'settling', ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, binding, ts, ts);
    const record = this.get(key);
    if (record === undefined) throw new Error(`consumed proof ${key} vanished`);
    return { created: Number(res.changes) === 1, record };
  }

  /** Compare-and-set; returns false if the proof is not in `from`. */
  transition(
    key: string,
    from: ProofState,
    to: ProofState,
    patch: { paymentResponse?: string; response?: StoredResponse } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE consumed_proofs
            SET state = ?, updated_at = ?,
                payment_response = COALESCE(?, payment_response),
                response_status = COALESCE(?, response_status),
                response_headers = COALESCE(?, response_headers),
                response_body = COALESCE(?, response_body)
          WHERE key = ? AND state = ?`,
      )
      .run(
        to,
        this.now(),
        patch.paymentResponse ?? null,
        patch.response?.status ?? null,
        patch.response === undefined ? null : JSON.stringify(patch.response.headers),
        patch.response?.body ?? null,
        key,
        from,
      );
    return Number(res.changes) === 1;
  }

  /**
   * Records a SETTLED payment as paid (`settling → paid_not_served`), also when
   * a concurrent request removed or moved its row meanwhile: the payment did
   * settle, so it must stay servable once. Atomic; returns the stored state.
   */
  markSettled(key: string, binding: string, paymentResponse: string): ProofState {
    const ts = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO consumed_proofs (key, binding, state, payment_response, created_at, updated_at)
           VALUES (?, ?, 'paid_not_served', ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET state = 'paid_not_served', payment_response = excluded.payment_response,
             updated_at = excluded.updated_at
           WHERE consumed_proofs.state = 'settling'`,
        )
        .run(key, binding, paymentResponse, ts, ts);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const record = this.get(key);
    if (record === undefined) throw new Error(`consumed proof ${key} vanished`);
    return record.state;
  }

  /**
   * Recovers a proof stuck in `serving` (the process died while the handler
   * ran): after `leaseSeconds` it goes back to `paid_not_served` (already
   * settled) or `settling` (authorization flow, not settled yet), so the SAME
   * payment can complete the operation. Compare-and-set: one winner.
   */
  reclaimStale(key: string, leaseSeconds: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE consumed_proofs
            SET state = CASE WHEN payment_response IS NULL THEN 'settling' ELSE 'paid_not_served' END,
                updated_at = ?
          WHERE key = ? AND state = 'serving' AND updated_at <= ?`,
      )
      .run(this.now(), key, this.now() - leaseSeconds);
    return Number(res.changes) === 1;
  }

  /** Removes a proof that never reached the network (e.g. rejected at verification). */
  forget(key: string, state: ProofState): void {
    this.db.prepare('DELETE FROM consumed_proofs WHERE key = ? AND state = ?').run(key, state);
  }
}

function toRecord(row: Row): ProofRecord {
  return {
    key: row.key,
    binding: row.binding,
    state: row.state,
    paymentResponse: row.payment_response,
    response:
      row.response_status === null
        ? null
        : {
            status: row.response_status,
            headers: JSON.parse(row.response_headers ?? '{}') as Record<string, string>,
            body: row.response_body ?? new Uint8Array(),
          },
    updatedAt: row.updated_at,
  };
}
