import { createHash } from 'node:crypto';
import type { PaymentPayload, SettleResponse } from '@x402/core/types';
import { canonical } from '@obbyx/x402-obyte';
import type { Logger } from '@obbyx/obyte/logger';

/** Thrown by x402 core when no mechanism matches (version/scheme/network). */
export function isUnsupported(err: unknown): boolean {
  return /No facilitator registered/.test(err instanceof Error ? err.message : String(err));
}

/**
 * Identifier of the payment proof for a pending answer: the unit hash (exact)
 * or the voucher hash (batch). `settlement_pending` must carry a non-empty
 * `transaction`.
 */
export function proofIdOf(payload: PaymentPayload): string {
  const unit = (payload.payload['unit'] as { unit?: unknown } | undefined)?.unit;
  if (typeof unit === 'string') return unit;
  return createHash('sha256').update(canonical(payload.payload)).digest('hex');
}

/**
 * An unexpected error during /settle may have happened AFTER the payment was
 * claimed or broadcast (e.g. a store failure). Reporting a definite failure
 * would make the seller drop a payment that can still complete, so the answer
 * is "pending": the caller repeats the same request; settlement is idempotent.
 */
export function settleUnexpected(
  err: unknown,
  payload: PaymentPayload,
  network: string,
  log: Logger,
): SettleResponse {
  if (isUnsupported(err)) {
    return {
      success: false,
      errorReason: 'unsupported_scheme',
      errorMessage: err instanceof Error ? err.message : String(err),
      transaction: '',
      network: network as SettleResponse['network'],
    };
  }
  log.error({ err }, 'unexpected error during settle; reported as pending (fail-safe)');
  return {
    success: false,
    errorReason: 'settlement_pending',
    errorMessage: 'Internal error; repeat the same request',
    transaction: proofIdOf(payload),
    network: network as SettleResponse['network'],
  };
}

export function verifyUnexpected(err: unknown, log: Logger) {
  if (isUnsupported(err)) {
    return {
      isValid: false as const,
      invalidReason: 'unsupported_scheme',
      invalidMessage: err instanceof Error ? err.message : String(err),
    };
  }
  log.error({ err }, 'unexpected error during verify');
  return {
    isValid: false as const,
    invalidReason: 'unexpected_verify_error',
    invalidMessage: 'Internal error',
  };
}
