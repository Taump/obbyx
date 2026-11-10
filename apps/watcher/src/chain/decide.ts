/**
 * Pure decision logic of the seller watcher for one channel (party A = seller,
 * party B = client), against the channel base AAs: v1.2
 * 7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR (CHANNEL_BASE_AA, the only one new vouchers
 * are accepted for) and the legacy v1.1 4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ
 * (LEGACY_CHANNEL_BASE_AAS: existing channels are still closed and defended;
 * close / confirm / fraud_proof triggers are the same on both).
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

/** Pause before confirming an honest client close (vouchers still in flight first). */
export const DEFAULT_CONFIRM_GRACE_SECONDS = 120;

export interface ClosePolicy {
  /** Close once the period's cumulative amount reaches this (atomic units). */
  readonly closeAtAmount: bigint;
  /** Close once the period's first voucher is this old (seconds). */
  readonly closeAfterSeconds: number;
  /**
   * Wait this long after a client-initiated close before confirming it
   * (default 120 s, at most half the dispute window): vouchers the facilitator
   * accepted just before the close reached the AA are still being delivered
   * and acked. A dishonest close is answered with a fraud proof at once.
   */
  readonly confirmGraceSeconds?: number;
}

/**
 * What to do now. `alert` reports an invariant violation to log loudly; it
 * never stops the seller from cashing out (the decision is still taken).
 */
export type Decision = (
  | { readonly action: 'none'; readonly why: string }
  | { readonly action: 'fraud_proof'; readonly period: number; readonly why: string }
  | { readonly action: 'confirm'; readonly period: number; readonly why: string }
  | { readonly action: 'close'; readonly period: number; readonly why: string }
) & { readonly alert?: string };

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
    const grace = Math.min(
      policy.confirmGraceSeconds ?? DEFAULT_CONFIRM_GRACE_SECONDS,
      Math.floor(timeout / 2),
    );
    const confirmAt = (state.closeStartTs ?? 0) + grace; // no start time known: confirm now
    if (now < confirmAt) {
      return {
        action: 'none',
        why: `honest client close; confirming at ${confirmAt} (in-flight vouchers first)`,
      };
    }
    return { action: 'confirm', period, why: 'client-initiated close is honest' };
  }

  if (state.closeInitiatedBy === 'A') {
    const deadline = (state.closeStartTs ?? 0) + timeout;
    return now >= deadline
      ? { action: 'confirm', period, why: 'our close passed its dispute window' }
      : { action: 'none', why: `our close can be confirmed at ${deadline}` };
  }

  if (ours === undefined) return { action: 'none', why: 'nothing earned in this period' };
  const decision: Decision =
    ours.amountSpent >= policy.closeAtAmount
      ? { action: 'close', period, why: `earned ${ours.amountSpent} ≥ ${policy.closeAtAmount}` }
      : now - ours.firstReceivedAt >= policy.closeAfterSeconds
        ? { action: 'close', period, why: `period open for ${now - ours.firstReceivedAt} s` }
        : { action: 'none', why: 'within policy' };
  // Must never happen (the facilitator checks the confirmed deposit), but it
  // must not keep the seller from cashing out either: the AA clamps the
  // payout to the balance, so we still close and only raise the alarm.
  return ours.amountSpent > state.balanceB
    ? { ...decision, alert: `voucher ${ours.amountSpent} exceeds balanceB ${state.balanceB}` }
    : decision;
}

/**
 * Parses the AA state vars of a channel into a ChannelState. A var the AA
 * deleted (or never set) is absent; a var that is PRESENT with an unexpected
 * type means a malformed answer: undefined (skip this tick), never a guess
 * such as a zero balance.
 */
export function channelState(vars: Record<string, unknown>): ChannelState | undefined {
  const by = vars['close_initiated_by'];
  const ints = {
    period: vars['period'],
    closeStartTs: vars['close_start_ts'],
    spentByB: vars['spentByB'],
    balanceB: vars['balanceB'],
  };
  if (Object.values(ints).some((v) => v !== undefined && !Number.isSafeInteger(v)))
    return undefined;
  if (by !== undefined && by !== 'A' && by !== 'B') return undefined;
  const { period, closeStartTs, spentByB, balanceB } = ints as Record<string, number | undefined>;
  return {
    period,
    closeInitiatedBy: by,
    closeStartTs,
    spentByB: spentByB === undefined ? undefined : BigInt(spentByB),
    balanceB: BigInt(balanceB ?? 0), // deleted by the AA after a close: no deposit yet
  };
}
