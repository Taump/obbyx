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
  CHANNEL_BASE_AA,
  ObbyxError,
  fromDisplay,
  getNetwork,
  isAssetId,
  networkKey,
  parseAmount,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  BATCH_SCHEME,
  EXACT_SCHEME,
  batchExtraSchema,
  bindingsEqual,
  exactExtraSchema,
  packageHashOf,
  voucherPackageOf,
} from '@obbyx/x402-obyte';
import type { ConsumedProofsStore } from './consumed-proofs.js';
import { DEFAULT_QUOTE_TTL_SECONDS, DEFAULT_SERVING_LEASE_SECONDS } from './defaults.js';
import { type Quote, bodyHashOf, newQuote, offerBinding } from './quote.js';

/**
 * Obyte schemes for the OFFICIAL x402 resource server (`@x402/core/server`,
 * `@x402/express`, `@x402/hono`, …): SchemeNetworkServer implementations for
 * `exact` ({@link ObyteExactServer}) and `batch-settlement`
 * ({@link ObyteBatchServer}), sharing {@link ObyteSchemeServer}.
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
export interface ObyteSchemeServerOptions {
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

/** @deprecated Use {@link ObyteSchemeServerOptions}. */
export type ObyteExactServerOptions = ObyteSchemeServerOptions;

/** Options of {@link ObyteBatchServer}. */
export interface ObyteBatchServerOptions extends ObyteSchemeServerOptions {
  /** Minimum channel dispute window the seller accepts (seconds); must match the facilitator's. */
  readonly minChannelTimeoutSeconds: number;
}

/** Per-scheme parts of an Obyte resource-server scheme. */
export interface ObyteSchemeSpec {
  readonly scheme: typeof EXACT_SCHEME | typeof BATCH_SCHEME;
  /** `extra` fields the scheme adds to every offer besides binding and quote. */
  readonly staticExtra: Record<string, unknown>;
  /** Parses the quote fields of the accepted offer. */
  readonly acceptedExtra: (extra: unknown) => {
    readonly binding: string;
    readonly quoteId: string;
    readonly validUntil: number;
  };
  /** Proof id and key kind of a payment payload (undefined when malformed). */
  readonly proofOf: (payload: Record<string, unknown>) => { kind: string; id: string } | undefined;
}

export abstract class ObyteSchemeServer implements SchemeNetworkServer {
  readonly scheme: string;
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = {
    default: { supported: ['upfront'] as const, default: 'upfront' as const },
  };
  readonly dynamicExtraFields = ['binding', 'quoteId', 'validUntil'];
  readonly schemeHooks: SchemeServerHooks;
  private readonly log: Logger;
  private readonly now: () => number;

  protected constructor(
    private readonly options: ObyteSchemeServerOptions,
    private readonly spec: ObyteSchemeSpec,
  ) {
    this.scheme = spec.scheme;
    this.log = moduleLogger(options.logger, 'sdk.x402-server', { scheme: spec.scheme });
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.schemeHooks = {
      onBeforeVerify: async (ctx) => {
        const key = this.keyOf(ctx);
        const binding = (ctx.requirements.extra as { binding?: unknown }).binding;
        if (key === undefined || typeof binding !== 'string') {
          return { abort: true, reason: 'invalid_payload' };
        }
        const { record } = this.options.proofs.begin(key, binding);
        if (!bindingsEqual(record.binding, binding))
          return { abort: true, reason: 'invalid_payment_reused' };
        if (record.state === 'served') {
          this.log.warn({ proofId: key }, 'payment already served a request; refused');
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

  /** Nothing to add from /supported; the per-request fields come from the enrich hook. */
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
      throw new ObbyxError('no_request', `Obyte ${this.scheme} needs the HTTP request context`);
    const accepted = this.acceptedQuote(request);
    return ctx.requirements.map((req) => {
      if (req.scheme !== this.spec.scheme) return req;
      const quote =
        accepted !== undefined &&
        bindingsEqual(this.bindingFor(req, request, accepted), accepted.binding)
          ? accepted
          : undefined;
      const extra = { ...req.extra, ...this.spec.staticExtra };
      if (quote !== undefined) return { ...req, extra: { ...extra, ...quote } };
      const fresh = newQuote(this.now(), this.options.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS);
      return {
        ...req,
        extra: { ...extra, binding: this.bindingFor(req, request, fresh), ...fresh },
      };
    });
  };

  private acceptedQuote(request: RequestLike) {
    if (request.paymentHeader === undefined) return undefined;
    try {
      const accepted = decodePaymentSignatureHeader(request.paymentHeader).accepted;
      if (accepted?.scheme !== this.spec.scheme) return undefined;
      const extra = this.spec.acceptedExtra(accepted.extra);
      return { quoteId: extra.quoteId, validUntil: extra.validUntil, binding: extra.binding };
    } catch {
      return undefined;
    }
  }

  private bindingFor(req: PaymentRequirements, request: RequestLike, quote: Quote): string {
    return offerBinding(
      this.options,
      this.spec.scheme,
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
    const proof = this.spec.proofOf(ctx.paymentPayload.payload);
    return proof === undefined
      ? undefined
      : networkKey(getNetwork(ctx.requirements.network), proof.kind, proof.id);
  }
}

/** `exact`: the proof is the unit (key `<network>:unit:<hash>`, as ObytePaywall). */
export class ObyteExactServer extends ObyteSchemeServer {
  constructor(options: ObyteSchemeServerOptions) {
    super(options, {
      scheme: EXACT_SCHEME,
      staticExtra: {},
      acceptedExtra: (extra) => exactExtraSchema.parse(extra),
      proofOf: (payload) => {
        const unit = (payload as { unit?: { unit?: unknown } }).unit?.unit;
        return typeof unit === 'string' ? { kind: 'unit', id: unit } : undefined;
      },
    });
  }
}

/**
 * `batch-settlement` (AA payment channels): the proof is the voucher (key
 * `<network>:voucher:<sha256 of the canonical signed package>`, as
 * ObytePaywall). Offers carry the channel base AA and the minimum dispute
 * window. Needs a facilitator with batch-settlement and the seller's watcher.
 */
export class ObyteBatchServer extends ObyteSchemeServer {
  constructor(options: ObyteBatchServerOptions) {
    super(options, {
      scheme: BATCH_SCHEME,
      staticExtra: { baseAa: CHANNEL_BASE_AA, minTimeout: options.minChannelTimeoutSeconds },
      acceptedExtra: (extra) => batchExtraSchema.parse(extra),
      proofOf: (payload) => {
        const pkg = voucherPackageOf(payload);
        return pkg === undefined ? undefined : { kind: 'voucher', id: packageHashOf(pkg) };
      },
    });
  }
}
