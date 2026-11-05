import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
} from "@x402/core/types";
import { bindingsEqual, bodyHashOf, computeBinding, newQuoteId } from "../../binding";
import {
  BYTES_ASSET,
  BYTES_DECIMALS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SERVING_LEASE_SECONDS,
  ERR_INVALID_PAYLOAD,
  ERR_PAYMENT_ALREADY_USED,
  ERR_PAYMENT_IN_PROGRESS,
  ERR_PAYMENT_REUSED,
  SCHEME_EXACT,
} from "../../constants";
import { InMemoryObyteProofStore, type ObyteProofStore } from "../../proofStore";
import { type ExactObyteExtra, exactObyteExtraSchema } from "../../types";
import { displayToAtomic, isAssetId, isObyteNetwork, parseAtomicAmount } from "../../utils";
import { unitHashOf, unitKey } from "../requirements";

/** Resource-server configuration. */
export interface ExactObyteServerConfig {
  /** Identifies this seller inside the binding (e.g. the API's name). */
  readonly sellerId: string;
  /** HMAC key of the bindings, at least 32 bytes; keep it secret and stable. */
  readonly secret: string | Uint8Array;
  /** Payment registry; defaults to a process-local one. */
  readonly proofs?: ObyteProofStore;
  /** Lifetime of an offer, seconds. */
  readonly quoteTtlSeconds?: number;
  /** How long a request may hold a payment in `serving` before a retry takes over, seconds. */
  readonly servingLeaseSeconds?: number;
  /** Clock in unix seconds. */
  readonly now?: () => number;
}

/** The request facts a binding covers. */
interface RequestFacts {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly paymentHeader: string | undefined;
}

/** Hook context fields used to find the payment. */
interface PaymentHookContext {
  paymentPayload: { payload: Record<string, unknown> };
  requirements: { network: string; extra?: Record<string, unknown> };
}

/**
 * Obyte resource server for the `exact` scheme.
 *
 * Binding: every offer gets a per-request HMAC binding and quote
 * (`enrichPaymentRequiredResponse`). On a paid request the binding is
 * recomputed from the request and the quote the client accepted; only if it
 * matches are those fields reused (`dynamicExtraFields`), so the facilitator
 * sees exactly what the client signed. Otherwise a fresh binding is issued and
 * the payment fails verification.
 *
 * One payment, one request: settlement at the facilitator is idempotent per
 * unit, so the scheme hooks keep a registry and claim a payment before
 * settling it; a payment that already served a request is refused.
 */
export class ExactObyteScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_EXACT;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    // Upfront only: the payment is claimed and settled before the handler runs.
    // With `authorization` the handler would run before the claim, so two
    // concurrent requests carrying one payment could both be served.
    default: { supported: ["upfront"] as const, default: "upfront" as const },
  };
  readonly dynamicExtraFields = ["binding", "quoteId", "validUntil"];
  readonly schemeHooks: SchemeServerHooks;
  private readonly config: ExactObyteServerConfig;
  private readonly proofs: ObyteProofStore;
  private readonly now: () => number;

  /**
   * Creates the server scheme.
   *
   * @param config - Seller identity, binding secret and registry.
   */
  constructor(config: ExactObyteServerConfig) {
    const secretLength =
      typeof config.secret === "string"
        ? new TextEncoder().encode(config.secret).length
        : config.secret.length;
    if (secretLength < 32) throw new Error("ExactObyteScheme: secret must be at least 32 bytes");
    if (config.sellerId.length === 0) throw new Error("ExactObyteScheme: sellerId is required");
    this.config = config;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.proofs = config.proofs ?? new InMemoryObyteProofStore(this.now);
    this.schemeHooks = {
      onBeforeVerify: async ctx => {
        const key = this.keyOf(ctx);
        const binding = ctx.requirements.extra?.["binding"];
        if (key === undefined || typeof binding !== "string") {
          return { abort: true, reason: ERR_INVALID_PAYLOAD };
        }
        const record = await this.proofs.begin(key, binding);
        if (!bindingsEqual(record.binding, binding)) {
          return { abort: true, reason: ERR_PAYMENT_REUSED };
        }
        if (record.state === "served") return { abort: true, reason: ERR_PAYMENT_ALREADY_USED };
        return undefined;
      },
      // Claim (settling → serving) before settling: two concurrent requests with
      // the same payment can never both reach the handler.
      onBeforeSettle: async ctx => {
        const key = this.keyOf(ctx);
        if (key === undefined) return { abort: true, reason: ERR_INVALID_PAYLOAD };
        await this.proofs.reclaimStale(
          key,
          this.config.servingLeaseSeconds ?? DEFAULT_SERVING_LEASE_SECONDS,
        );
        if (await this.proofs.transition(key, "settling", "serving")) return undefined;
        const state = (await this.proofs.get(key))?.state;
        return {
          abort: true,
          reason: state === "served" ? ERR_PAYMENT_ALREADY_USED : ERR_PAYMENT_IN_PROGRESS,
        };
      },
      // Success consumes the payment; pending or failed releases it for a retry
      // with the same payment.
      onAfterSettle: async ctx => {
        const key = this.keyOf(ctx);
        if (key === undefined) return;
        if (ctx.result.success) await this.proofs.transition(key, "serving", "served");
        else await this.proofs.transition(key, "serving", "settling");
      },
      onSettleFailure: async ctx => {
        const key = this.keyOf(ctx);
        if (key !== undefined) await this.proofs.transition(key, "serving", "settling");
      },
      // The handler failed after the payment was claimed or settled: the same
      // payment stays usable for the same operation (settle is idempotent).
      onVerifiedPaymentCanceled: async ctx => {
        const key = this.keyOf(ctx);
        if (key === undefined) return;
        if (!(await this.proofs.transition(key, "serving", "settling"))) {
          await this.proofs.transition(key, "served", "settling");
        }
      },
    };
  }

  /**
   * Converts a price: `{asset, amount}` in atomic units, `"<n> bytes"` or
   * `"<x> GBYTE"`. Obyte has no default USD asset, so `$` prices are refused.
   *
   * @param price - The route price.
   * @param network - Network identifier.
   * @returns Asset and atomic amount.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isObyteNetwork(network)) throw new Error(`Unsupported Obyte network: ${network}`);
    if (typeof price === "object" && price !== null) {
      const amount = parseAtomicAmount(price.amount);
      if (!isAssetId(price.asset) || amount === undefined) {
        throw new Error("Obyte price must be {asset: 'base' | <asset id>, amount: <atomic units>}");
      }
      return { asset: price.asset, amount: amount.toString() };
    }
    const [, value, unit] =
      /^\s*([0-9]+(?:\.[0-9]+)?)\s*(bytes|gbyte)\s*$/i.exec(String(price)) ?? [];
    const amount =
      value === undefined || unit === undefined
        ? undefined
        : unit.toLowerCase() === "bytes"
          ? parseAtomicAmount(value)
          : displayToAtomic(value, BYTES_DECIMALS);
    if (amount === undefined || amount <= 0n) {
      throw new Error('Obyte price must be {asset, amount}, "<n> bytes" or "<x> GBYTE"');
    }
    return { asset: BYTES_ASSET, amount: amount.toString() };
  }

  /**
   * Decimals of an asset (bytes only; other assets are not known locally).
   *
   * @param asset - Asset id.
   * @returns 9 for bytes in GBYTE, otherwise undefined.
   */
  getAssetDecimals(asset: string): number | undefined {
    return asset === BYTES_ASSET ? BYTES_DECIMALS : undefined;
  }

  /**
   * Nothing to add from `/supported`; the per-request fields come from the enrich hook.
   *
   * @param requirements - Base requirements.
   * @returns The same requirements.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
  ): Promise<PaymentRequirements> {
    return requirements;
  }

  /**
   * Adds (or, for a valid paid request, re-confirms) the per-request binding and quote.
   *
   * @param ctx - Requirements and the HTTP request.
   * @returns The requirements with `extra.binding`, `quoteId`, `validUntil`.
   */
  enrichPaymentRequiredResponse = async (
    ctx: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> => {
    const request = requestOf(ctx.transportContext);
    if (request === undefined) throw new Error("Obyte exact needs the HTTP request context");
    const accepted = acceptedQuote(request);
    return ctx.requirements.map(req => {
      if (req.scheme !== SCHEME_EXACT) return req;
      if (
        accepted !== undefined &&
        bindingsEqual(this.bindingFor(req, request, accepted), accepted.binding)
      ) {
        return { ...req, extra: { ...req.extra, ...accepted } };
      }
      const quote = {
        quoteId: newQuoteId(),
        validUntil: this.now() + (this.config.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS),
      };
      return {
        ...req,
        extra: { ...req.extra, binding: this.bindingFor(req, request, quote), ...quote },
      };
    });
  };

  /**
   * Binding of an offer to the request.
   *
   * @param req - Requirements of the offer.
   * @param request - The HTTP request.
   * @param quote - Offer id and expiry.
   * @param quote.quoteId - Offer id.
   * @param quote.validUntil - Offer expiry.
   * @returns The binding.
   */
  private bindingFor(
    req: PaymentRequirements,
    request: RequestFacts,
    quote: { quoteId: string; validUntil: number },
  ): string {
    return computeBinding(this.config.secret, {
      sellerId: this.config.sellerId,
      scheme: SCHEME_EXACT,
      quoteId: quote.quoteId,
      validUntil: quote.validUntil,
      method: request.method,
      url: request.url,
      bodyHash: bodyHashOf(request.body),
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      payTo: req.payTo,
    });
  }

  /**
   * Registry key of the payment in a hook context.
   *
   * @param ctx - Hook context.
   * @returns `<network>:unit:<hash>`, or undefined when malformed.
   */
  private keyOf(ctx: PaymentHookContext): string | undefined {
    const unit = unitHashOf(ctx.paymentPayload);
    return unit === undefined ? undefined : unitKey(ctx.requirements.network, unit);
  }
}

/**
 * The HTTP request from the transport context of the official middleware.
 *
 * @param transportContext - Transport context.
 * @returns Method, path and query, body and payment header; undefined without a request.
 */
function requestOf(transportContext: unknown): RequestFacts | undefined {
  const request = (transportContext as { request?: Record<string, unknown> } | undefined)?.request;
  const adapter = request?.["adapter"] as
    { getMethod(): string; getUrl(): string; getBody?(): unknown } | undefined;
  if (adapter === undefined) return undefined;
  const url = new URL(adapter.getUrl(), "http://localhost");
  return {
    method: adapter.getMethod(),
    url: url.pathname + url.search,
    body: adapter.getBody?.(),
    paymentHeader:
      typeof request?.["paymentHeader"] === "string" ? request["paymentHeader"] : undefined,
  };
}

/**
 * The quote fields of the offer the client accepted, if well-formed.
 *
 * @param request - The HTTP request.
 * @returns The accepted `extra`, or undefined.
 */
function acceptedQuote(request: RequestFacts): ExactObyteExtra | undefined {
  if (request.paymentHeader === undefined) return undefined;
  try {
    const extra = exactObyteExtraSchema.safeParse(
      decodePaymentSignatureHeader(request.paymentHeader).accepted?.extra,
    );
    return extra.success ? extra.data : undefined;
  } catch {
    return undefined;
  }
}
