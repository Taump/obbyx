import type { PaymentPayload } from '@x402/core/types';
import { z } from 'zod';

/**
 * x402 `payment-identifier` extension (seller side): a client-chosen id makes
 * a repeated operation return the stored response instead of charging again.
 */
export const PAYMENT_IDENTIFIER = 'payment-identifier';

/** Same constraints as @x402/extensions (16–128 chars of [A-Za-z0-9_-]). */
export const paymentIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/);

const extensionSchema = z
  .object({ info: z.object({ id: z.unknown().optional() }).loose() })
  .loose();

/** Same declaration as @x402/extensions `declarePaymentIdentifierExtension`. */
export function paymentIdentifierDeclaration(required: boolean) {
  return {
    info: { required },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        id: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
      },
      required: ['required'],
    },
  };
}

/** The client's id: `undefined` when absent, `'invalid'` when malformed. */
export function paymentIdOf(payload: PaymentPayload): string | undefined | 'invalid' {
  const raw = payload.extensions?.[PAYMENT_IDENTIFIER];
  if (raw === undefined) return undefined;
  const ext = extensionSchema.safeParse(raw);
  if (!ext.success) return 'invalid';
  const id = ext.data.info.id;
  if (id === undefined) return undefined;
  const parsed = paymentIdSchema.safeParse(id);
  return parsed.success ? parsed.data : 'invalid';
}

/** What the store needs for payment-identifier decisions. */
export interface PaymentIdStore {
  bindPaymentId(
    scopeId: string,
    fingerprint: string,
    proofKey: string,
  ): { fingerprint: string; proofKey: string; created: boolean };
  /** Compare-and-set: moves the id to `proofKey` only if it still points at `previous`. */
  rebindPaymentId(scopeId: string, previous: string, proofKey: string): boolean;
  get(
    key: string,
  ): { state: string; response: unknown; paymentResponse: string | null } | undefined;
}

export type PaymentIdDecision =
  | { kind: 'proceed' }
  | { kind: 'replay'; proofKey: string }
  | { kind: 'reject'; status: 400 | 409; error: string };

/**
 * One client id = one operation. Contract: the caller has already created the
 * proof row for `proofKey` (so other requests see it as in progress).
 * Concurrent retries with DIFFERENT payments
 * for the same id: exactly one wins the compare-and-set; the others get 409,
 * so an id can never be charged twice.
 */
export function decidePaymentId(
  store: PaymentIdStore,
  input: {
    paymentId: string | undefined | 'invalid';
    required: boolean;
    scopeId: (id: string) => string;
    fingerprint: string;
    proofKey: string;
  },
): PaymentIdDecision {
  const { paymentId } = input;
  if (paymentId === 'invalid')
    return { kind: 'reject', status: 400, error: 'invalid_payment_identifier' };
  if (paymentId === undefined) {
    return input.required
      ? { kind: 'reject', status: 400, error: 'payment_identifier_required' }
      : { kind: 'proceed' };
  }
  const scopeId = input.scopeId(paymentId);
  const mapping = store.bindPaymentId(scopeId, input.fingerprint, input.proofKey);
  if (mapping.fingerprint !== input.fingerprint) {
    return { kind: 'reject', status: 409, error: 'payment_identifier_conflict' };
  }
  if (mapping.proofKey === input.proofKey) return { kind: 'proceed' };
  const original = store.get(mapping.proofKey);
  if (original?.state === 'served') return { kind: 'replay', proofKey: mapping.proofKey };
  if (original !== undefined && original.state !== 'failed') {
    return { kind: 'reject', status: 409, error: 'payment_in_progress' };
  }
  // The earlier attempt definitely failed (or never consumed its proof): move the id.
  return store.rebindPaymentId(scopeId, mapping.proofKey, input.proofKey)
    ? { kind: 'proceed' }
    : { kind: 'reject', status: 409, error: 'payment_in_progress' };
}
