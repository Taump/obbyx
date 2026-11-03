import { decodePaymentSignatureHeader } from '@x402/core/http';
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
} from '@x402/core/types';
import {
  ObbyxError,
  fromDisplay,
  getNetwork,
  isAssetId,
  networkKey,
  parseAmount,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import { EXACT_SCHEME, bindingsEqual, exactExtraSchema } from '@obbyx/x402-obyte';
import type { ConsumedProofsStore } from './consumed-proofs.js';
import { DEFAULT_QUOTE_TTL_SECONDS, DEFAULT_SERVING_LEASE_SECONDS } from './defaults.js';
import { type Quote, bodyHashOf, newQuote, offerBinding } from './quote.js';

/**
 * Obyte `exact` for the OFFICIAL x402 resource server (`@x402/core/server`,
 * `@x402/express`, `@x402/hono`, …): a SchemeNetworkServer.
 *
 * - Binding (I1/I2): `enrichPaymentRequiredResponse` adds a per-request HMAC
 *   binding + quote to every offer. On a paid request it recomputes the HMAC
 *   from the request and the quote the client accepted; only if it matches are
 *   those fields reused (declared in `dynamicExtraFields`), so the facilitator
 *   then sees exactly the requirements the client signed. Otherwise a fresh
 *   binding is issued and the facilitator refuses the payment.
 * - One payment, one operation (I3): the official middleware keeps no
 *   consumed-proof registry, so the scheme hooks do — `onBeforeVerify` refuses
 *   a proof that already served a request, `onAfterSettle` marks it served.
 *   Unlike `@obbyx/sdk`'s ObytePaywall, a repeated request gets a 402 instead
 *   of the stored response (the official middleware cannot replay responses).
 */
export interface ObyteExactServerOptions {
  /** How long a request may hold a payment in `serving` before a retry takes over (default 300 s). */
  readonly servingLeaseSeconds?: number;
  readonly sellerId: string;
  /** HMAC key for bindings (≥ 32 bytes). */
  readonly secret: string | Uint8Array;
  readonly proofs: ConsumedProofsStore;
  readonly logger: Logger;
  readonly quoteTtlSeconds?: number;
  readonly now?: () => number;
}

interface RequestLike {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly paymentHeader: string | undefined;
}

function requestOf(transportContext: unknown): RequestLike | undefined {
  const request = (transportContext as { request?: Record<string, unknown> } | undefined)?.request;
  const adapter = request?.['adapter'] as
    { getMethod(): string; getUrl(): string; getBody?(): unknown } | undefined;
  if (adapter === undefined) return undefined;
  const url = new URL(adapter.getUrl(), 'http://localhost');
  return {
    method: adapter.getMethod(),
    url: url.pathname + url.search,
    body: adapter.getBody?.(),
    paymentHeader:
      typeof request?.['paymentHeader'] === 'string' ? request['paymentHeader'] : undefined,
  };
}

export class ObyteExactServer implements SchemeNetworkServer {
  readonly scheme = EXACT_SCHEME;
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = {
    default: { supported: ['upfront'] as const, default: 'upfront' as const },
  };
  readonly dynamicExtraFields = ['binding', 'quoteId', 'validUntil'];
  readonly schemeHooks: SchemeServerHooks;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly options: ObyteExactServerOptions) {
    this.log = moduleLogger(options.logger, 'sdk.x402-server', { scheme: EXACT_SCHEME });
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.schemeHooks = {
      onBeforeVerify: async (ctx) => {
        const unit = (ctx.paymentPayload.payload as { unit?: { unit?: unknown } }).unit?.unit;
        const binding = (ctx.requirements.extra as { binding?: unknown }).binding;
        if (typeof unit !== 'string' || typeof binding !== 'string') {
          return { abort: true, reason: 'invalid_payload' };
        }
        const { record } = this.options.proofs.begin(
          this.key(ctx.requirements.network, unit),
          binding,
        );
        if (!bindingsEqual(record.binding, binding))
          return { abort: true, reason: 'invalid_payment_reused' };
        if (record.state === 'served') {
          this.log.warn({ proofId: unit }, 'payment already served a request; refused');
          return { abort: true, reason: 'payment_already_used' };
        }
        return undefined;
      },
      // Claim the proof atomically (settling → serving) before settling, so two
      // concurrent requests with the same payment can never both reach the
      // handler: the official middleware runs the handler after a successful
      // settle, and the facilitator answers success for both (idempotent).
      onBeforeSettle: async (ctx) => {
        const key = this.keyOf(ctx);
        if (key === undefined) return { abort: true, reason: 'invalid_payload' };
        const proofs = this.options.proofs;
        // A claim left behind by a crashed process is taken over after the lease.
        proofs.reclaimStale(key, this.options.servingLeaseSeconds ?? DEFAULT_SERVING_LEASE_SECONDS);
        if (
          proofs.transition(key, 'settling', 'serving') ||
          // settled earlier, but the handler failed: serve it now (settle is idempotent)
          proofs.transition(key, 'paid_not_served', 'serving')
        ) {
          return undefined;
        }
        const state = this.options.proofs.get(key)?.state;
        this.log.warn({ state }, 'payment already in use by another request; refused');
        return {
          abort: true,
          reason: state === 'served' ? 'payment_already_used' : 'payment_in_progress',
        };
      },
      onAfterSettle: async (ctx) => {
        const key = this.keyOf(ctx);
        if (key === undefined) return;
        // Success: one operation consumed the proof. Otherwise (pending, failed):
        // release the claim so the SAME payment can be retried.
        if (ctx.result.success) this.options.proofs.transition(key, 'serving', 'served');
        else this.options.proofs.transition(key, 'serving', 'settling');
      },
      // The handler failed or threw after the payment was settled (upfront):
      // the payment stays usable for the SAME operation instead of "already used".
      onVerifiedPaymentCanceled: async (ctx) => {
        const key = this.keyOf(ctx);
        if (key === undefined) return;
        if (ctx.settledPhases.includes('before-handler')) {
          this.options.proofs.transition(key, 'served', 'paid_not_served');
        } else {
          this.options.proofs.transition(key, 'serving', 'settling');
        }
        this.log.warn(
          { reason: ctx.reason },
          'paid request not served; the same payment can retry',
        );
      },
      onSettleFailure: async (ctx) => {
        const key = this.keyOf(ctx);
        if (key !== undefined) this.options.proofs.transition(key, 'serving', 'settling');
      },
    };
  }

  /** `{asset, amount}` in atomic units, or "20000 bytes" / "0.00002 GBYTE". */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    getNetwork(network);
    if (typeof price === 'object') {
      if (!isAssetId(price.asset))
        throw new ObbyxError('invalid_price', `Invalid asset ${price.asset}`);
      return { asset: price.asset, amount: parseAmount(price.amount).toString() };
    }
    const [, value, unit] =
      /^\s*([0-9]+(?:\.[0-9]+)?)\s*(bytes|gbyte)\s*$/i.exec(String(price)) ?? [];
    if (value === undefined || unit === undefined) {
      throw new ObbyxError(
        'invalid_price',
        'Use {asset, amount} or "<n> bytes" / "<x> GBYTE" (no USD default asset on Obyte yet)',
      );
    }
    const amount = unit.toLowerCase() === 'bytes' ? parseAmount(value) : fromDisplay(value, 9);
    return { asset: 'base', amount: amount.toString() };
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset === 'base' ? 9 : undefined;
  }

  /** Nothing to add from /supported for exact; the per-request fields come from the enrich hook. */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
  ): Promise<PaymentRequirements> {
    return requirements;
  }

  /** Adds (or, for a valid paid request, re-confirms) the per-request binding and quote. */
  enrichPaymentRequiredResponse = async (
    ctx: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> => {
    const request = requestOf(ctx.transportContext);
    if (request === undefined)
      throw new ObbyxError('no_request', 'Obyte exact needs the HTTP request context');
    const accepted = this.acceptedQuote(request);
    return ctx.requirements.map((req) => {
      if (req.scheme !== EXACT_SCHEME) return req;
      const quote =
        accepted !== undefined &&
        bindingsEqual(this.bindingFor(req, request, accepted), accepted.binding)
          ? accepted
          : undefined;
      if (quote !== undefined) return { ...req, extra: { ...req.extra, ...quote } };
      const fresh = newQuote(this.now(), this.options.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS);
      return {
        ...req,
        extra: { ...req.extra, binding: this.bindingFor(req, request, fresh), ...fresh },
      };
    });
  };

  private acceptedQuote(request: RequestLike) {
    if (request.paymentHeader === undefined) return undefined;
    try {
      const extra = exactExtraSchema.safeParse(
        decodePaymentSignatureHeader(request.paymentHeader).accepted?.extra,
      );
      return extra.success ? extra.data : undefined;
    } catch {
      return undefined;
    }
  }

  private bindingFor(req: PaymentRequirements, request: RequestLike, quote: Quote): string {
    return offerBinding(
      this.options,
      EXACT_SCHEME,
      quote,
      { method: request.method, url: request.url, bodyHash: bodyHashOf(request.body) },
      { network: req.network, asset: req.asset, amount: req.amount, payTo: req.payTo },
    );
  }

  /** Proof key of the payment in a hook context (undefined when malformed). */
  private keyOf(ctx: {
    paymentPayload: { payload: Record<string, unknown> };
    requirements: { network: string };
  }): string | undefined {
    const unit = (ctx.paymentPayload.payload as { unit?: { unit?: unknown } }).unit?.unit;
    return typeof unit === 'string' ? this.key(ctx.requirements.network, unit) : undefined;
  }

  private key(network: string, unit: string): string {
    return networkKey(getNetwork(network), 'unit', unit);
  }
}
