/**
 * Pure decision logic of the seller watcher for one channel (party A = seller,
 * party B = client), against the base channel AA 4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ.
 *
 * Safety argument (ADR-0003, synchronous ack): the facilitator reports a
 * voucher as paid only after this watcher stored it, so the local database
 * always contains every voucher the seller was paid for. Decisions therefore
 * depend only on local data and the on-chain state, never on the connection
 * to the facilitator.
 */
export interface ChannelState {
  /** AA state var `period` (undefined before the first deposit). */
  readonly period: number | undefined;
  readonly closeInitiatedBy: 'A' | 'B' | undefined;
  /** Unix seconds. */
  readonly closeStartTs: number | undefined;
  /** What the client (B) declared it spent when it started the close. */
  readonly spentByB: bigint | undefined;
  readonly balanceB: bigint;
}

export interface BestVoucher {
  readonly period: number;
  readonly amountSpent: bigint;
  /** When the earliest voucher of this period was received (unix s). */
  readonly firstReceivedAt: number;
}

export interface ClosePolicy {
  /** Close once the period's cumulative amount reaches this (atomic units). */
  readonly closeAtAmount: bigint;
  /** Close once the period's first voucher is this old (seconds). */
  readonly closeAfterSeconds: number;
}

export type Decision =
  | { readonly action: 'none'; readonly why: string }
  | { readonly action: 'fraud_proof'; readonly period: number; readonly why: string }
  | { readonly action: 'confirm'; readonly period: number; readonly why: string }
  | { readonly action: 'close'; readonly period: number; readonly why: string }
  | { readonly action: 'alert'; readonly why: string };

export function decide(input: {
  readonly state: ChannelState;
  readonly best: BestVoucher | undefined;
  readonly timeout: number;
  readonly now: number;
  readonly policy: ClosePolicy;
}): Decision {
  const { state, best, timeout, now, policy } = input;
  if (state.period === undefined) return { action: 'none', why: 'channel not opened yet' };
  const period = state.period;
  const ours = best?.period === period ? best : undefined;

  if (state.closeInitiatedBy === 'B') {
    const declared = state.spentByB ?? 0n;
    if (ours !== undefined && ours.amountSpent > declared) {
      return {
        action: 'fraud_proof',
        period,
        why: `client declared ${declared} but signed ${ours.amountSpent}`,
      };
    }
    return { action: 'confirm', period, why: 'client-initiated close is honest; confirm now' };
  }

  if (state.closeInitiatedBy === 'A') {
    const deadline = (state.closeStartTs ?? 0) + timeout;
    return now >= deadline
      ? { action: 'confirm', period, why: 'our close passed its dispute window' }
      : { action: 'none', why: `our close can be confirmed at ${deadline}` };
  }

  if (ours === undefined) return { action: 'none', why: 'nothing earned in this period' };
  if (ours.amountSpent > state.balanceB) {
    // Must never happen: the facilitator checks the confirmed deposit.
    return {
      action: 'alert',
      why: `voucher ${ours.amountSpent} exceeds balanceB ${state.balanceB}`,
    };
  }
  if (ours.amountSpent >= policy.closeAtAmount) {
    return { action: 'close', period, why: `earned ${ours.amountSpent} ≥ ${policy.closeAtAmount}` };
  }
  if (now - ours.firstReceivedAt >= policy.closeAfterSeconds) {
    return { action: 'close', period, why: `period open for ${now - ours.firstReceivedAt} s` };
  }
  return { action: 'none', why: 'within policy' };
}

/** Parses the AA state vars of a channel into a ChannelState. */
export function channelState(vars: Record<string, unknown>): ChannelState {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const big = (v: unknown) => (typeof v === 'number' ? BigInt(v) : undefined);
  const by = vars['close_initiated_by'];
  return {
    period: num(vars['period']),
    closeInitiatedBy: by === 'A' || by === 'B' ? by : undefined,
    closeStartTs: num(vars['close_start_ts']),
    spentByB: big(vars['spentByB']),
    balanceB: big(vars['balanceB']) ?? 0n,
  };
}
