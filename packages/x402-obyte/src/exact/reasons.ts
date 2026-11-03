/** Settlement/verification reasons of the `exact` facilitator beyond the unit profile ones. */
export const EXACT_SETTLE_REASONS = {
  pending: 'settlement_pending',
  rejected: 'invalid_exact_obyte_rejected_by_network',
  finalBad: 'invalid_exact_obyte_double_spend',
  expired: 'invalid_exact_obyte_publication_window_expired',
  ledger: 'invalid_exact_obyte_ledger_unavailable',
  inputs: 'invalid_exact_obyte_inputs',
  stale: 'invalid_exact_obyte_stale',
  quoteExpired: 'invalid_exact_obyte_quote_expired',
  payToAa: 'invalid_exact_obyte_payto_is_aa',
  acceptedMismatch: 'invalid_payment_requirements',
  version: 'invalid_x402_version',
  payload: 'invalid_payload',
} as const;

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };
export const fail = (
  reason: string,
  message: string,
): { ok: false; reason: string; message: string } => ({
  ok: false,
  reason,
  message,
});
