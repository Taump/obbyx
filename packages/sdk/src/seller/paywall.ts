import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  type FacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import {
  CHANNEL_BASE_AA,
  getNetwork,
  isAddress,
  isAssetId,
  networkKey,
  parseAmount,
} from '@obbyx/obyte';
import { type Logger, moduleLogger, withLogContext } from '@obbyx/obyte/logger';
import {
  BATCH_SCHEME,
  EXACT_SCHEME,
  batchExtraSchema,
  canonical,
  exactExtraSchema,
} from '@obbyx/x402-obyte';
import { bindingsEqual, sha256Hex } from './binding.js';
import {
  PAYMENT_IDENTIFIER,
  decidePaymentId,
  paymentIdOf,
  paymentIdentifierDeclaration,
} from './payment-identifier.js';
import {
  type PaymentTerms,
  type RequestFacts,
  bodyHashOf,
  newQuote,
  offerBinding,
  operationFingerprint,
} from './quote.js';
import type { ConsumedProofsStore, StoredResponse } from './consumed-proofs.js';
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SERVING_LEASE_SECONDS,
} from './defaults.js';

/**
 * Express paywall for x402 `exact` payments on Obyte (seller side).
 *
 * Flow `upfront` (phase 3): settle to the facilitator's finality BEFORE the
 * handler runs; the handler runs at most once per payment proof; a repeat of
 * the same operation with the same proof returns the stored response.
 *
 * Paid handlers return their response instead of writing to `res`, so the
 * paywall can store it for idempotent replays.
 */
export interface PaidResult {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Objects are sent as JSON; strings/bytes as-is. */
  readonly body: unknown;
}

export type PaidHandler = (req: Request) => Promise<PaidResult> | PaidResult;

export interface RoutePrice {
  /** Atomic units as a decimal string. */
  readonly amount: string;
  /** `'base'` for bytes or an asset id. */
  readonly asset?: string;
}

export interface PaidRouteOptions {
  readonly price: RoutePrice;
  readonly description?: string;
  readonly mimeType?: string;
  /** What identifies "the same operation". Default: sha256 of the canonical JSON body. */
  readonly fingerprint?: (req: Request) => string;
  /** Offered schemes in order of preference. Default: batch-settlement (if enabled), exact. */
  readonly schemes?: readonly PaywallScheme[];
  /**
   * `upfront` (default): settle, then run the handler — for anything expensive
   * or irreversible. `authorization`: verify, run the handler, settle, then
   * send — only for cheap, idempotent handlers: if the settlement then fails,
   * the handler's side effects have happened but its response is withheld.
   */
  readonly flow?: 'upfront' | 'authorization';
}

export type PaywallScheme = typeof EXACT_SCHEME | typeof BATCH_SCHEME;

export interface ObytePaywallOptions {
  readonly facilitator: FacilitatorClient;
  readonly network: string;
  readonly payTo: string;
  /** Stable identifier of this seller/API (part of the binding). */
  readonly sellerId: string;
  /** HMAC key for bindings; keep secret, ≥ 32 bytes. */
  readonly secret: string | Uint8Array;
  readonly store: ConsumedProofsStore;
  readonly logger: Logger;
  readonly quoteTtlSeconds?: number;
  readonly maxTimeoutSeconds?: number;
  /** How long one request waits for `settlement_pending` to resolve. */
  readonly settleWaitMs?: number;
  readonly settlePollMs?: number;
  /**
   * How long a request may hold a payment in `serving` (default 300 s). After
   * that a retry with the same payment takes over (crash recovery); set it
   * above the slowest handler.
   */
  readonly servingLeaseSeconds?: number;
  /**
   * Declares the x402 `payment-identifier` extension: a client-chosen id makes a
   * repeated operation return the stored response instead of charging again.
   */
  readonly paymentIdentifier?: { readonly required: boolean };
  /** Enables batch-settlement (AA payment channels) offers; requires a running seller watcher. */
  readonly batch?: { readonly minChannelTimeoutSeconds: number };
  readonly now?: () => number;
}

const EXPOSE = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE';

export class ObytePaywall {
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly options: ObytePaywallOptions) {
    getNetwork(options.network);
    if (!isAddress(options.payTo)) throw new Error('payTo must be a valid Obyte address');
    if (
      (typeof options.secret === 'string'
        ? Buffer.byteLength(options.secret)
        : options.secret.length) < 32
    ) {
      throw new Error('secret must be at least 32 bytes');
    }
    this.log = moduleLogger(options.logger, 'sdk.paywall', { network: options.network });
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Wraps a handler so it only runs after a settled payment. */
  paid(route: PaidRouteOptions, handler: PaidHandler): RequestHandler {
    const asset = route.price.asset ?? 'base';
    if (!isAssetId(asset)) throw new Error(`Invalid asset ${asset}`);
    const amount = parseAmount(route.price.amount).toString();
    return (req: Request, res: Response, next: NextFunction) => {
      const requestId = String(req.get('x-request-id') ?? cryptoId());
      withLogContext({ requestId, network: this.options.network }, () =>
        this.handle(req, res, route, { asset, amount }, handler).catch(next),
      );
    };
  }

  private async handle(
    req: Request,
    res: Response,
    route: PaidRouteOptions,
    price: { asset: string; amount: string },
    handler: PaidHandler,
  ): Promise<void> {
    res.setHeader('Access-Control-Expose-Headers', EXPOSE);
    res.setHeader('Cache-Control', 'private, no-store');
    const header = req.get('payment-signature');
    if (header === undefined) return this.paymentRequired(req, res, route, price);

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      res.status(400).json({ error: 'invalid_payment_header' });
      return;
    }
    const accepted = payload.accepted;
    const scheme = accepted?.scheme as PaywallScheme | undefined;
    const offered = this.schemesFor(route);
    const extra =
      scheme === EXACT_SCHEME
        ? exactExtraSchema.safeParse(accepted?.extra)
        : scheme === BATCH_SCHEME
          ? batchExtraSchema.safeParse(accepted?.extra)
          : undefined;
    const proofId = scheme === undefined ? undefined : proofIdOf(scheme, payload);
    if (
      payload.x402Version !== 2 ||
      scheme === undefined ||
      !offered.includes(scheme) ||
      accepted?.network !== this.options.network ||
      accepted.asset !== price.asset ||
      accepted.amount !== price.amount ||
      accepted.payTo !== this.options.payTo ||
      extra === undefined ||
      !extra.success ||
      proofId === undefined ||
      (scheme === BATCH_SCHEME &&
        (extra.data as { minTimeout?: number }).minTimeout !==
          this.options.batch?.minChannelTimeoutSeconds)
    ) {
      return this.paymentRequired(req, res, route, price, 'invalid_payment_requirements');
    }
    const facts = this.requestFacts(req, route);
    const terms = this.terms(price);
    const expected = offerBinding(this.options, scheme, extra.data, facts, terms);
    if (!bindingsEqual(expected, extra.data.binding)) {
      this.log.warn({ proofId }, 'payment is bound to another operation or a forged quote');
      return this.paymentRequired(req, res, route, price, 'invalid_binding');
    }
    const binding = extra.data.binding;
    const key = networkKey(
      getNetwork(this.options.network),
      scheme === EXACT_SCHEME ? 'unit' : 'voucher',
      proofId,
    );

    await withLogContext({ binding, proofId }, async () => {
      const store = this.options.store;
      const begun = store.begin(key, binding);
      const { created } = begun;
      let { record } = begun;
      // A proof left in `serving` by a crashed process is recovered after the lease.
      if (
        record.state === 'serving' &&
        store.reclaimStale(key, this.options.servingLeaseSeconds ?? DEFAULT_SERVING_LEASE_SECONDS)
      ) {
        this.log.warn('recovered a payment stuck in serving (lease expired)');
        record = store.get(key) ?? record;
      }
      if (!bindingsEqual(record.binding, binding)) {
        res.setHeader('PAYMENT-RESPONSE', this.refusal('invalid_payment_reused'));
        res.status(402).json({ error: 'invalid_payment_reused' });
        return;
      }
      // x402 payment-identifier: one client id = one operation. Decided AFTER
      // the proof row exists, so a concurrent request always sees this proof
      // as in progress (never as "absent") and cannot take the id over.
      if (this.options.paymentIdentifier !== undefined) {
        const decision = decidePaymentId(store, {
          paymentId: paymentIdOf(payload),
          required: this.options.paymentIdentifier.required,
          scopeId: (id) => `${this.options.sellerId}:${id}`,
          fingerprint: operationFingerprint(facts, terms),
          proofKey: key,
        });
        if (decision.kind !== 'proceed' && created) store.forget(key, 'settling');
        if (decision.kind === 'reject') {
          res.status(decision.status).json({ error: decision.error });
          return;
        }
        if (decision.kind === 'replay') {
          const original = store.get(decision.proofKey);
          this.log.info('payment-identifier repeat: stored response, new payment NOT settled');
          return this.send(res, original?.response ?? null, original?.paymentResponse ?? null);
        }
      }
      if (created && extra.data.validUntil < this.now()) {
        store.forget(key, 'settling');
        return this.paymentRequired(req, res, route, price, 'quote_expired');
      }
      switch (record.state) {
        case 'served':
          this.log.info('replaying stored response for a repeated operation');
          return this.send(res, record.response, record.paymentResponse);
        case 'serving':
          if (record.paymentResponse !== null)
            res.setHeader('PAYMENT-RESPONSE', record.paymentResponse);
          res.status(409).json({ error: 'payment_in_progress' });
          return;
        case 'failed':
          res.status(402).json({ error: 'payment_failed' });
          return;
        case 'paid_not_served':
          return this.serve(req, res, key, record.paymentResponse, handler);
        case 'awaiting_settle':
          return this.settleServed(req, res, route, price, key, payload, accepted);
        case 'settling':
          break;
      }

      if (route.flow === 'authorization') {
        return this.authorize(req, res, route, price, key, payload, accepted, handler);
      }

      const settled = await this.settleWithWait(payload, accepted);
      const paymentResponse = encodePaymentResponseHeader(settled);
      if (settled.success) {
        this.log.info({ transaction: settled.transaction }, 'payment settled');
        if (store.markSettled(key, binding, paymentResponse) === 'served') {
          // A concurrent request with the same payment already served it.
          const served = store.get(key);
          return this.send(res, served?.response ?? null, served?.paymentResponse ?? null);
        }
        return this.serve(req, res, key, paymentResponse, handler);
      }
      if (settled.errorReason === 'settlement_pending') {
        this.log.info(
          { transaction: settled.transaction },
          'settlement pending; client should retry with the same payment',
        );
        res.setHeader('PAYMENT-RESPONSE', paymentResponse);
        res.setHeader('Retry-After', '5');
        res.status(402).json({ error: 'settlement_pending', transaction: settled.transaction });
        return;
      }
      if (settled.transaction === '') {
        // Rejected before reaching the network: the proof was not consumed.
        // Only the request that created the row removes it: a concurrent
        // request with the same payment may be settling it right now.
        if (created) store.forget(key, 'settling');
      } else {
        store.transition(key, 'settling', 'failed', { paymentResponse });
      }
      this.log.warn({ reason: settled.errorReason }, 'payment failed');
      res.setHeader('PAYMENT-RESPONSE', paymentResponse);
      return this.paymentRequired(req, res, route, price, settled.errorReason ?? 'payment_failed');
    });
  }

  /** authorization flow: verify → handler (response stored) → settle → send. */
  private async authorize(
    req: Request,
    res: Response,
    route: PaidRouteOptions,
    price: { asset: string; amount: string },
    key: string,
    payload: PaymentPayload,
    accepted: PaymentRequirements,
    handler: PaidHandler,
  ): Promise<void> {
    const store = this.options.store;
    let verified;
    try {
      verified = await this.options.facilitator.verify(payload, accepted);
    } catch (err) {
      this.log.warn({ err }, 'facilitator unreachable during verify');
      store.forget(key, 'settling');
      res.status(503).json({ error: 'facilitator_unavailable' });
      return;
    }
    if (!verified.isValid) {
      store.forget(key, 'settling');
      return this.paymentRequired(
        req,
        res,
        route,
        price,
        verified.invalidReason ?? 'invalid_payment',
      );
    }
    if (!store.transition(key, 'settling', 'serving')) {
      res.status(409).json({ error: 'payment_in_progress' });
      return;
    }
    let result: PaidResult;
    try {
      result = await handler(req);
    } catch (err) {
      store.transition(key, 'serving', 'settling'); // nothing settled; the same payment may retry
      this.log.error({ err }, 'paid handler failed before settlement');
      res.status(500).json({ error: 'handler_failed', retry: 'same payment, same request' });
      return;
    }
    store.transition(key, 'serving', 'awaiting_settle', { response: toStored(result) });
    return this.settleServed(req, res, route, price, key, payload, accepted);
  }

  private async settleServed(
    req: Request,
    res: Response,
    route: PaidRouteOptions,
    price: { asset: string; amount: string },
    key: string,
    payload: PaymentPayload,
    accepted: PaymentRequirements,
  ): Promise<void> {
    const store = this.options.store;
    const settled = await this.settleWithWait(payload, accepted);
    const paymentResponse = encodePaymentResponseHeader(settled);
    if (settled.success) {
      store.transition(key, 'awaiting_settle', 'served', { paymentResponse });
      const record = store.get(key);
      this.log.info(
        { transaction: settled.transaction },
        'payment settled after the handler; response sent',
      );
      return this.send(res, record?.response ?? null, paymentResponse);
    }
    res.setHeader('PAYMENT-RESPONSE', paymentResponse);
    if (settled.errorReason === 'settlement_pending') {
      res.setHeader('Retry-After', '5');
      res.status(402).json({ error: 'settlement_pending', transaction: settled.transaction });
      return;
    }
    store.transition(key, 'awaiting_settle', 'failed', { paymentResponse });
    this.log.warn(
      { reason: settled.errorReason },
      'payment failed AFTER the handler ran (authorization flow); response withheld',
    );
    return this.paymentRequired(req, res, route, price, settled.errorReason ?? 'payment_failed');
  }

  private async serve(
    req: Request,
    res: Response,
    key: string,
    paymentResponse: string | null,
    handler: PaidHandler,
  ): Promise<void> {
    const store = this.options.store;
    if (!store.transition(key, 'paid_not_served', 'serving')) {
      res.status(409).json({ error: 'payment_in_progress' });
      return;
    }
    let result: PaidResult;
    try {
      result = await handler(req);
    } catch (err) {
      store.transition(key, 'serving', 'paid_not_served');
      this.log.error(
        { err },
        'paid handler failed; the payment can be retried for the same operation',
      );
      // The payment WAS settled: tell the client (its budget must count it).
      if (paymentResponse !== null) res.setHeader('PAYMENT-RESPONSE', paymentResponse);
      res.status(500).json({ error: 'handler_failed', retry: 'same payment, same request' });
      return;
    }
    const response = toStored(result);
    if (!store.transition(key, 'serving', 'served', { response })) {
      this.log.error('lost the serving state while storing the response');
    }
    this.log.info({ status: response.status }, 'paid response served');
    this.send(res, response, paymentResponse);
  }

  private send(
    res: Response,
    response: StoredResponse | null,
    paymentResponse: string | null,
  ): void {
    if (response === null) {
      res.status(500).json({ error: 'missing_stored_response' });
      return;
    }
    if (paymentResponse !== null) res.setHeader('PAYMENT-RESPONSE', paymentResponse);
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    res.status(response.status).end(Buffer.from(response.body));
  }

  private paymentRequired(
    req: Request,
    res: Response,
    route: PaidRouteOptions,
    price: { asset: string; amount: string },
    error?: string,
  ): void {
    // A refused payment that was never settled: say so explicitly (success:
    // false, empty transaction) so the client knows it was NOT used and can
    // release its budget and its channel voucher. A settle failure already
    // set its own PAYMENT-RESPONSE.
    if (error !== undefined && !res.hasHeader('PAYMENT-RESPONSE')) {
      res.setHeader('PAYMENT-RESPONSE', this.refusal(error));
    }
    const quote = newQuote(this.now(), this.options.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS);
    const facts = this.requestFacts(req, route);
    const terms = this.terms(price);
    const accepts: PaymentRequirements[] = this.schemesFor(route).map((scheme) => ({
      scheme,
      network: this.options.network as PaymentRequirements['network'],
      asset: price.asset,
      amount: price.amount,
      payTo: this.options.payTo,
      maxTimeoutSeconds: this.options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: {
        binding: offerBinding(this.options, scheme, quote, facts, terms),
        ...quote,
        // x402 §6.1: a non-default flow must be declared in the offer.
        ...(route.flow === 'authorization' ? {} : { paymentFlow: 'upfront' }),
        ...(scheme === BATCH_SCHEME
          ? {
              baseAa: CHANNEL_BASE_AA,
              minTimeout: this.options.batch?.minChannelTimeoutSeconds ?? 0,
            }
          : {}),
      },
    }));
    const body: PaymentRequired = {
      x402Version: 2,
      ...(error === undefined ? {} : { error }),
      resource: {
        url: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
        ...(route.description ? { description: route.description } : {}),
        ...(route.mimeType ? { mimeType: route.mimeType } : {}),
      },
      accepts,
      ...(this.options.paymentIdentifier
        ? {
            extensions: {
              [PAYMENT_IDENTIFIER]: paymentIdentifierDeclaration(
                this.options.paymentIdentifier.required,
              ),
            },
          }
        : {}),
    };
    res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body));
    res.status(402).json(body);
  }

  /** PAYMENT-RESPONSE of a payment refused before settlement (not used, nothing charged). */
  private refusal(errorReason: string): string {
    return encodePaymentResponseHeader({
      success: false,
      errorReason,
      transaction: '',
      network: this.options.network as PaymentRequirements['network'],
    });
  }

  private requestFacts(req: Request, route: PaidRouteOptions): RequestFacts {
    return {
      method: req.method,
      url: req.originalUrl,
      bodyHash: route.fingerprint ? route.fingerprint(req) : bodyHashOf(req.body),
    };
  }

  private terms(price: { asset: string; amount: string }): PaymentTerms {
    return { network: this.options.network, payTo: this.options.payTo, ...price };
  }

  private schemesFor(route: PaidRouteOptions): readonly PaywallScheme[] {
    const all =
      route.schemes ?? (this.options.batch ? [BATCH_SCHEME, EXACT_SCHEME] : [EXACT_SCHEME]);
    return all.filter((s) => s === EXACT_SCHEME || this.options.batch !== undefined);
  }

  private async settleWithWait(
    payload: PaymentPayload,
    req: PaymentRequirements,
  ): Promise<SettleResponse> {
    const deadline = Date.now() + (this.options.settleWaitMs ?? 20_000);
    const poll = this.options.settlePollMs ?? 2_000;
    for (;;) {
      let res: SettleResponse;
      try {
        res = await this.options.facilitator.settle(payload, req);
      } catch (err) {
        // Unknown outcome talking to the facilitator: keep the proof in `settling`.
        this.log.warn({ err }, 'facilitator unreachable during settle');
        return {
          success: false,
          errorReason: 'settlement_pending',
          transaction: String(
            (payload.payload['unit'] as { unit?: unknown } | undefined)?.unit ?? '',
          ),
          network: req.network,
        };
      }
      if (res.errorReason !== 'settlement_pending' || Date.now() + poll > deadline) return res;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

/** Identifies a payment proof: the unit hash (exact) or the voucher hash (batch). */
function proofIdOf(scheme: PaywallScheme, payload: PaymentPayload): string | undefined {
  if (scheme === EXACT_SCHEME) {
    const hash = (payload.payload?.['unit'] as { unit?: unknown } | undefined)?.unit;
    return typeof hash === 'string' ? hash : undefined;
  }
  const pkg = payload.payload?.['signedPackage'];
  return pkg !== null && typeof pkg === 'object' ? sha256Hex(canonical(pkg)) : undefined;
}

function toStored(result: PaidResult): StoredResponse {
  const headers: Record<string, string> = { ...(result.headers ?? {}) };
  let body: Uint8Array;
  if (result.body instanceof Uint8Array) body = result.body;
  else if (typeof result.body === 'string') body = Buffer.from(result.body);
  else {
    body = Buffer.from(JSON.stringify(result.body));
    headers['content-type'] ??= 'application/json; charset=utf-8';
  }
  return { status: result.status ?? 200, headers, body };
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}
