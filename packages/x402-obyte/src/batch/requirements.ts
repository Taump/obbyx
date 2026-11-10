import type { PaymentRequirements } from '@x402/core/types';
import {
  CHANNEL_BASE_AA,
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
import { SHA256_HEX_RE } from '../util/format.js';

export const BATCH_SCHEME = 'batch-settlement';

/** Error codes of the Obyte binding (`invalid_batch_settlement_obyte_*`). */
export const BATCH_REASONS = {
  payload: 'invalid_batch_settlement_obyte_payload',
  signature: 'invalid_batch_settlement_obyte_voucher_signature',
  channel: 'invalid_batch_settlement_obyte_channel_not_found',
  channelParams: 'invalid_batch_settlement_obyte_channel_params',
  timeout: 'invalid_batch_settlement_obyte_channel_timeout',
  period: 'invalid_batch_settlement_obyte_period_mismatch',
  closing: 'invalid_batch_settlement_obyte_channel_closing',
  balance: 'invalid_batch_settlement_obyte_cumulative_exceeds_balance',
  cumulative: 'invalid_batch_settlement_obyte_cumulative_amount_mismatch',
  amount: 'invalid_batch_settlement_obyte_payment_amount_mismatch',
  binding: 'invalid_batch_settlement_obyte_binding_mismatch',
  busy: 'invalid_batch_settlement_obyte_channel_busy',
  watcher: 'invalid_batch_settlement_obyte_watcher_unavailable',
  /** The seller's watcher signed that it will not store this voucher (nack). */
  refused: 'invalid_batch_settlement_obyte_voucher_refused',
  ledger: 'invalid_batch_settlement_obyte_ledger_unavailable',
  quoteExpired: 'invalid_batch_settlement_obyte_quote_expired',
} as const;

/**
 * Largest amount a voucher may carry (`amount_spent`, `payment_amount`, the
 * price). Oscript numbers keep 15 significant digits: above 1e15 the AA's
 * arithmetic on the voucher (balance checks, payouts) is no longer exact, so
 * such a voucher could not be relied on in a close or a fraud proof.
 */
export const MAX_VOUCHER_AMOUNT = 1e15;

export const batchExtraSchema = z
  .object({
    binding: z.string().regex(SHA256_HEX_RE),
    quoteId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    validUntil: z.number().int().positive(),
    baseAa: z.literal(CHANNEL_BASE_AA),
    /** Minimum channel dispute window the seller accepts (seconds). */
    minTimeout: z.number().int().positive(),
    // x402 §6.1: Obyte supports the `upfront` flow (settle, then serve) and the
    // default `authorization` flow; `escrow` and any asset transfer method
    // (there is none on Obyte: the payer signs the transfer itself) are refused.
    paymentFlow: z.enum(['authorization', 'upfront']).optional(),
  })
  .strict();

export type BatchExtra = z.infer<typeof batchExtraSchema>;

/** The voucher: a signed package as used by aa-channels-lib, plus our binding. */
export const voucherMessageSchema = z
  .object({
    aa_address: z.string(),
    period: z.number().int().positive(),
    // Capped at 1e15: Oscript keeps 15 significant digits (MAX_VOUCHER_AMOUNT).
    amount_spent: z.number().int().positive().max(MAX_VOUCHER_AMOUNT),
    payment_amount: z.number().int().positive().max(MAX_VOUCHER_AMOUNT),
    binding: z.string().regex(SHA256_HEX_RE),
  })
  .strict();

export type VoucherMessage = z.infer<typeof voucherMessageSchema>;

export interface ParsedBatchRequirements {
  readonly network: ObyteNetwork;
  readonly asset: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly extra: BatchExtra;
}

export function parseBatchRequirements(req: PaymentRequirements): Verdict<ParsedBatchRequirements> {
  if (req.scheme !== BATCH_SCHEME)
    return reject('unsupported_scheme', 'Scheme is not batch-settlement');
  // x402 v2 only: the CAIP-2 id, never a v1 alias (stored entries are keyed by it).
  if (!isObyteNetwork(req.network) || getNetwork(req.network).caip2 !== req.network) {
    return reject('invalid_network', 'Not an Obyte CAIP-2 network');
  }
  if (!isAssetId(req.asset) || !isAddress(req.payTo)) {
    return reject('invalid_payment_requirements', 'Invalid asset or payTo');
  }
  let amount: bigint;
  try {
    amount = parseAmount(req.amount);
  } catch {
    return reject('invalid_payment_requirements', 'Invalid amount');
  }
  if (amount <= 0n) return reject('invalid_payment_requirements', 'Amount must be positive');
  if (amount > BigInt(MAX_VOUCHER_AMOUNT)) {
    return reject('invalid_payment_requirements', `Amount must not exceed ${MAX_VOUCHER_AMOUNT}`);
  }
  const extra = batchExtraSchema.safeParse(req.extra);
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
    extra: extra.data,
  });
}
