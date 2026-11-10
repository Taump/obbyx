import { z } from 'zod';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type {
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { ObbyxError } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type { BudgetReservation, SpendingBudget } from './budget.js';
import {
  BATCH_REASONS,
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

/**
 * A payment was signed and sent, but no answer came back (network error):
 * the seller may have charged it. Retry the same request with
 * `paymentHeader` (it never pays twice) instead of paying again.
 */
export class PaymentOutcomeUnknownError extends ObbyxError {
  constructor(
    readonly paymentHeader: string,
    cause: unknown,
  ) {
    super(
      'outcome_unknown',
      `The paid request got no answer (${cause instanceof Error ? cause.message : String(cause)}); retry the same request later with the same payment`,
      { cause },
    );
  }
}

/**
 * True when a payment was sent and its outcome is not known: a 5xx, a 409
 * (in progress), a pending/busy answer, an error answer without
 * PAYMENT-RESPONSE, or a channel voucher answered without PAYMENT-RESPONSE
 * (it stays pending). Retry the same request with `paymentHeader`.
 */
export function paymentOutcomeUnknown(result: PaidResponse): boolean {
  if (result.paymentHeader === undefined) return false;
  const { response, payment } = result;
  if (payment?.success === true) return false;
  if (response.status >= 500 || response.status === 409) return true;
  if (payment === undefined)
    return !response.ok || acceptedOf(result.paymentHeader)?.scheme === BATCH_SCHEME;
  return payment.errorReason === 'settlement_pending' || payment.errorReason === BATCH_REASONS.busy;
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

  // Once a payment is attached, a request that gets no answer has an unknown
  // outcome: report the payment so the caller can retry with it.
  const paidRequest = async (header: string) => {
    try {
      return await request(header);
    } catch (err) {
      throw new PaymentOutcomeUnknownError(header, err);
    }
  };

  let header = init.paymentHeader;
  let reservation: BudgetReservation | undefined;
  let response = header === undefined ? await request() : await paidRequest(header);
  if (response.status !== 402 && header === undefined) return { response };

  if (header === undefined) {
    const required = response.headers.get('PAYMENT-REQUIRED');
    if (required === null)
      throw new ObbyxError('invalid_402', '402 without PAYMENT-REQUIRED header');
    ({ header, reservation } = await signPayment(
      decodePaymentRequiredHeader(required),
      init.paymentId,
      url,
      options,
      log,
    ));
    response = await paidRequest(header);
  }

  const deadline = Date.now() + (options.pendingTimeoutMs ?? 120_000);
  for (;;) {
    const settle = readSettle(response);
    if (response.status !== 402 || settle?.errorReason !== 'settlement_pending') {
      recordOutcome(response, settle, header, reservation, options);
      return { response, ...(settle ? { payment: settle } : {}), paymentHeader: header };
    }
    if (Date.now() > deadline) throw new PaymentPendingError(header, settle.transaction);
    const retryAfter = Number(response.headers.get('Retry-After') ?? 5);
    // An HTTP-date or garbage would be NaN (a ~1 ms busy loop): fall back to 5 s.
    const retryAfterMs =
      (Number.isFinite(retryAfter) ? Math.min(15, Math.max(1, retryAfter)) : 5) * 1000;
    const wait = Math.max(0, Math.min(retryAfterMs, deadline - Date.now()));
    log.info(
      { transaction: settle.transaction, waitMs: wait },
      'settlement pending; retrying with the same payment',
    );
    await response.body?.cancel();
    await new Promise((r) => setTimeout(r, wait));
    response = await paidRequest(header);
  }
}

/**
 * Signs a payment for the first usable offer, in preference order (channel
 * first). A channel that turns out to be unusable before anything is signed
 * (not funded, closing, exhausted, busy) falls through to the next offer,
 * normally `exact`. The price is reserved in the budget BEFORE signing, so
 * concurrent calls cannot overshoot it.
 */
async function signPayment(
  offer: PaymentRequired,
  paymentId: string | undefined,
  url: string,
  options: PayingFetchOptions,
  log: Logger,
): Promise<{ header: string; reservation: BudgetReservation | undefined }> {
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
    const reservation = options.budget?.reserve(candidate.asset, BigInt(candidate.amount));
    let result: PaymentPayloadResult;
    try {
      result = await mechanism.createPaymentPayload(2, candidate);
    } catch (err) {
      if (reservation) options.budget?.release(reservation); // nothing was signed or sent
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
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: offer.resource,
      accepted: candidate,
      payload: result.payload,
      ...(offer.extensions ? { extensions: withPaymentId(offer.extensions, paymentId) } : {}),
    };
    const header = encodePaymentSignatureHeader(payload);
    // Kept with the pending voucher: the operation can be retried after a crash.
    if (candidate.scheme === BATCH_SCHEME)
      options.mechanisms.batch?.rememberPaymentHeader(candidate, header);
    return { header, reservation };
  }
  // Nothing else to pay with: report why the channel could not (e.g. payment_pending).
  throw lastChannelError ?? new ObbyxError('no_acceptable_offer', 'No offer could be paid');
}

/**
 * Applies the final answer: the channel voucher is confirmed or released, and
 * the budget reservation is spent on success. It is released ONLY on a 402
 * for a channel voucher: a refused voucher is superseded by the next one
 * (cumulative amounts), so it can never be charged on top. An `exact` unit is
 * complete and signed: the seller can still broadcast it whatever its 402
 * says (the answer is not authenticated), so it stays counted. Anything else
 * (5xx, 409, no settlement info) is an unknown outcome and stays counted (I7).
 */
function recordOutcome(
  response: Response,
  settle: SettleResponse | undefined,
  header: string,
  reservation: BudgetReservation | undefined,
  options: PayingFetchOptions,
): void {
  const accepted = acceptedOf(header);
  if (accepted?.scheme === BATCH_SCHEME) options.mechanisms.batch?.onSettled(accepted, settle);
  if (reservation === undefined || options.budget === undefined) return;
  if (settle?.success === true || (response.ok && settle === undefined)) {
    options.budget.spend(reservation);
  } else if (response.status === 402 && accepted?.scheme === BATCH_SCHEME) {
    options.budget.release(reservation);
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
