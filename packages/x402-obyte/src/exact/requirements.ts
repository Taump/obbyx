import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  type ObyteNetwork,
  type Verdict,
  accept,
  getNetwork,
  isAddress,
  isAssetId,
  isObyteNetwork,
  parseAmount,
  reject,
} from '@obbyx/obyte';
import { z } from 'zod';

export const EXACT_SCHEME = 'exact';

/**
 * Scheme-specific `extra` of x402 PaymentRequirements for `exact` on Obyte.
 *
 * `binding` is computed by the seller per request (an HMAC over the quote and
 * the request fingerprint, see `@obbyx/sdk`) and must be signed by the client
 * inside the unit's data message. `quoteId`/`validUntil` bound the offer.
 */
export const exactExtraSchema = z
  .object({
    binding: z.string().regex(/^[0-9a-f]{64}$/, 'binding must be 64 lowercase hex chars'),
    quoteId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    validUntil: z.number().int().positive(),
    // x402 §6.1: Obyte supports the `upfront` flow (settle, then serve) and the
    // default `authorization` flow; `escrow` and any asset transfer method
    // (there is none on Obyte: the payer signs the transfer itself) are refused.
    paymentFlow: z.enum(['authorization', 'upfront']).optional(),
  })
  .strict();

export type ExactExtra = z.infer<typeof exactExtraSchema>;

export interface ParsedExactRequirements {
  readonly network: ObyteNetwork;
  readonly asset: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: ExactExtra;
}

export function parseExactRequirements(req: PaymentRequirements): Verdict<ParsedExactRequirements> {
  if (req.scheme !== EXACT_SCHEME) return reject('unsupported_scheme', 'Scheme is not exact');
  if (!isObyteNetwork(req.network)) return reject('invalid_network', 'Not an Obyte network');
  if (!isAssetId(req.asset)) return reject('invalid_payment_requirements', 'Invalid asset');
  if (!isAddress(req.payTo)) return reject('invalid_payment_requirements', 'Invalid payTo');
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
    return reject('invalid_payment_requirements', 'Invalid maxTimeoutSeconds');
  }
  let amount: bigint;
  try {
    amount = parseAmount(req.amount);
  } catch {
    return reject('invalid_payment_requirements', 'Invalid amount');
  }
  if (amount <= 0n) return reject('invalid_payment_requirements', 'Amount must be positive');
  const extra = exactExtraSchema.safeParse(req.extra);
  if (!extra.success) {
    return reject(
      'invalid_payment_requirements',
      `Invalid extra: ${extra.error.issues[0]?.message}`,
    );
  }
  return accept({
    network: getNetwork(req.network),
    asset: req.asset,
    amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: extra.data,
  });
}

/**
 * x402 core does not compare the client's `accepted` requirements with the
 * server's; a mismatch could let a client pay under different terms.
 */
export function acceptedMatches(payload: PaymentPayload, req: PaymentRequirements): boolean {
  const a = payload.accepted;
  return (
    a !== undefined &&
    a.scheme === req.scheme &&
    a.network === req.network &&
    a.asset === req.asset &&
    a.amount === req.amount &&
    a.payTo === req.payTo &&
    a.maxTimeoutSeconds === req.maxTimeoutSeconds &&
    canonical(a.extra) === canonical(req.extra)
  );
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
        )
      : v,
  );
}
