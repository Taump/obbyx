import { z } from 'zod';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ObbyxError } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type { BudgetReservation, SpendingBudget } from './budget.js';
import {
  BATCH_SCHEME,
  type BatchObyteClient,
  EXACT_SCHEME,
  type ExactObyteClient,
} from '@obbyx/x402-obyte';

/**
 * fetch() that pays x402 `exact` Obyte payments (buyer side).
 *
 * - Pays only offers within `maxAmount` (atomic units per asset).
 * - Redirects are not followed automatically: a payment is never re-sent to
 *   another origin.
 * - `settlement_pending` is retried with the SAME payment (never a new one)
 *   until `pendingTimeoutMs`; if still unknown, it throws `PaymentPendingError`
 *   carrying the payment header so the caller can retry later (I7).
 */
export interface PayingFetchOptions {
  /** Payment mechanisms; a channel (batch) is preferred when one exists to the seller. */
  readonly mechanisms: { readonly exact?: ExactObyteClient; readonly batch?: BatchObyteClient };
  readonly network: string;
  readonly maxAmount: ReadonlyMap<string, bigint>;
  readonly logger: Logger;
  readonly pendingTimeoutMs?: number;
  /** Shared spending budget (per-call and total limits, reserved atomically). */
  readonly budget?: SpendingBudget;
  readonly fetch?: typeof fetch;
}

export interface PaidResponse {
  readonly response: Response;
  readonly payment?: SettleResponse;
  /** Base64 PAYMENT-SIGNATURE that was sent, for retries of the same operation. */
  readonly paymentHeader?: string;
}

export class PaymentPendingError extends ObbyxError {
  constructor(
    readonly paymentHeader: string,
    readonly transaction: string,
  ) {
    super(
      'settlement_pending',
      `Payment ${transaction} is not final yet; retry the same request later with the same payment`,
    );
  }
}

export async function payingFetch(
  url: string,
  init: RequestInit & {
    paymentHeader?: string;
    /** x402 payment-identifier for this operation (reuse it when retrying after a lost response). */
    paymentId?: string;
  },
  options: PayingFetchOptions,
): Promise<PaidResponse> {
  const log = moduleLogger(options.logger, 'sdk.fetch');
  const doFetch = options.fetch ?? fetch;
  const request = (header?: string) =>
    doFetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...headersOf(init.headers), ...(header ? { 'PAYMENT-SIGNATURE': header } : {}) },
    });

  let header = init.paymentHeader;
  let reservation: BudgetReservation | undefined;
  let response = await request(header);
  if (response.status !== 402 && header === undefined) return { response };

  if (header === undefined) {
    const required = response.headers.get('PAYMENT-REQUIRED');
    if (required === null)
      throw new ObbyxError('invalid_402', '402 without PAYMENT-REQUIRED header');
    const offer = decodePaymentRequiredHeader(required);
    // Offers in preference order (channel first). A channel that turns out to
    // be unusable before anything is signed (not funded, closing, exhausted,
    // busy) falls through to the next offer, normally `exact`.
    let accepted: PaymentRequirements | undefined;
    let result: Awaited<ReturnType<ExactObyteClient['createPaymentPayload']>> | undefined;
    let lastChannelError: ObbyxError | undefined;
    for (const candidate of chooseOffers(offer.accepts, options)) {
      const mechanism =
        candidate.scheme === BATCH_SCHEME ? options.mechanisms.batch : options.mechanisms.exact;
      if (mechanism === undefined) continue;
      log.info(
        {
          url,
          scheme: candidate.scheme,
          payTo: candidate.payTo,
          asset: candidate.asset,
          amount: candidate.amount,
        },
        'paying for request',
      );
      // Reserve the price BEFORE signing: concurrent calls cannot overshoot the budget.
      reservation = options.budget?.reserve(candidate.asset, BigInt(candidate.amount));
      try {
        result = await mechanism.createPaymentPayload(2, candidate);
        accepted = candidate;
        break;
      } catch (err) {
        if (reservation) options.budget?.release(reservation); // nothing was signed or sent
        reservation = undefined;
        if (err instanceof ObbyxError && CHANNEL_UNUSABLE.has(err.code)) {
          lastChannelError = err;
          log.info(
            { reason: err.code, detail: err.message },
            'channel unusable; trying the next offer',
          );
          continue;
        }
        throw err;
      }
    }
    if (accepted === undefined || result === undefined) {
      // Nothing else to pay with: report why the channel could not (e.g. payment_pending).
      throw lastChannelError ?? new ObbyxError('no_acceptable_offer', 'No offer could be paid');
    }
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: offer.resource,
      accepted,
      payload: result.payload,
      ...(offer.extensions ? { extensions: withPaymentId(offer.extensions, init.paymentId) } : {}),
    };
    header = encodePaymentSignatureHeader(payload);
    response = await request(header);
  }

  const deadline = Date.now() + (options.pendingTimeoutMs ?? 120_000);
  for (;;) {
    const settle = readSettle(response);
    if (response.status !== 402 || settle?.errorReason !== 'settlement_pending') {
      const accepted = acceptedOf(header);
      if (accepted?.scheme === BATCH_SCHEME) options.mechanisms.batch?.onSettled(accepted, settle);
      if (reservation !== undefined && options.budget !== undefined) {
        // I7: spend on success; release ONLY on a definite refusal (402: the
        // payment was not used). Anything else (5xx, 409, no settlement info)
        // is an unknown outcome: the reservation stays counted.
        if (settle?.success === true || (response.ok && settle === undefined))
          options.budget.spend(reservation);
        else if (response.status === 402) options.budget.release(reservation);
      }
      return { response, ...(settle ? { payment: settle } : {}), paymentHeader: header };
    }
    if (Date.now() > deadline) throw new PaymentPendingError(header, settle.transaction);
    const retryAfterMs = Math.min(15, Number(response.headers.get('Retry-After') ?? 5)) * 1000;
    const wait = Math.max(0, Math.min(retryAfterMs, deadline - Date.now()));
    log.info(
      { transaction: settle.transaction, waitMs: wait },
      'settlement pending; retrying with the same payment',
    );
    await response.body?.cancel();
    await new Promise((r) => setTimeout(r, wait));
    response = await request(header);
  }
}

/** An offer from an untrusted seller: integer amount in smallest units, strings elsewhere. */
const offerShape = z
  .object({
    scheme: z.string(),
    network: z.string(),
    asset: z.string(),
    amount: z.string().regex(/^\d{1,30}$/),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()),
  })
  .loose();

/** Channel states in which the client signs nothing and can pay another way. */
const CHANNEL_UNUSABLE = new Set([
  'channel_not_funded',
  'channel_closing',
  'channel_exhausted',
  'payment_pending',
]);

/** Usable offers within the spending limit, a channel first (instant, no per-call fee). */
function chooseOffers(
  accepts: PaymentRequirements[],
  options: PayingFetchOptions,
): PaymentRequirements[] {
  const usable = (a: PaymentRequirements) =>
    offerShape.safeParse(a).success &&
    a.network === options.network &&
    ((a.scheme === BATCH_SCHEME && options.mechanisms.batch?.hasChannel(a) === true) ||
      (a.scheme === EXACT_SCHEME && options.mechanisms.exact !== undefined));
  const candidates = [
    ...accepts.filter((a) => a.scheme === BATCH_SCHEME),
    ...accepts.filter((a) => a.scheme !== BATCH_SCHEME),
  ].filter(usable);
  if (candidates.length === 0) {
    throw new ObbyxError('no_acceptable_offer', `No usable offer on ${options.network}`);
  }
  const affordable = candidates.filter((offer) => {
    const max = options.maxAmount.get(offer.asset);
    return max !== undefined && BigInt(offer.amount) <= max;
  });
  if (affordable.length === 0) {
    const prices = candidates.map((c) => `${c.amount} ${c.asset}`).join(', ');
    throw new ObbyxError('amount_over_limit', `Price (${prices}) exceeds your spending limit`);
  }
  return affordable;
}

/** Echoes the seller's extensions; fills the payment-identifier id if declared. */
function withPaymentId(
  extensions: Record<string, unknown>,
  id: string | undefined,
): Record<string, unknown> {
  const declared = extensions['payment-identifier'] as
    { info?: Record<string, unknown> } | undefined;
  if (declared === undefined) return extensions;
  const paymentId = id ?? `pay_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return {
    ...extensions,
    'payment-identifier': { ...declared, info: { ...declared.info, id: paymentId } },
  };
}

function acceptedOf(header: string): PaymentRequirements | undefined {
  try {
    return decodePaymentSignatureHeader(header).accepted;
  } catch {
    return undefined;
  }
}

function readSettle(response: Response): SettleResponse | undefined {
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (header === null) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

function headersOf(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}
