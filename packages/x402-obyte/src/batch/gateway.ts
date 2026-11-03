import type { CommitmentRow } from './store.js';

/**
 * Port to the sellers' watchers (ADR-0003, synchronous durable ack).
 *
 * `deliver` resolves `acked` only after the seller's watcher confirmed it has
 * durably stored the commitment; anything else is not an ack. The facilitator
 * reports success to the resource server only after `acked` (fail-closed).
 */
export interface WatcherHealth {
  readonly ok: boolean;
  readonly reason?: string;
  /** The seller announced it is closing this channel: refuse new vouchers for it. */
  readonly closing?: boolean;
}

export interface WatcherGateway {
  /** Is a watcher for this seller connected, recent and funded for defensive triggers? */
  health(payTo: string, network: string, aa?: string): WatcherHealth;
  /** Pushes a commitment and waits for the durable ack (or times out). */
  deliver(commitment: CommitmentRow, timeoutMs: number): Promise<'acked' | 'timeout'>;
}
