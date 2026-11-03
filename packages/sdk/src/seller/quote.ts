import { canonical, computeBinding, newQuoteId, sha256Hex } from '@obbyx/x402-obyte';

/**
 * Offers ("quotes") and their binding to ONE request — shared by ObytePaywall
 * and ObyteExactServer so both compute byte-identical bindings.
 *
 * binding = HMAC(secret, {sellerId, scheme, quoteId, validUntil, method, url,
 *           bodyHash, network, asset, amount, payTo})
 */
export interface RequestFacts {
  readonly method: string;
  /** Path and query string, as requested. */
  readonly url: string;
  /** sha256 hex of the canonical body, or a route-specific fingerprint. */
  readonly bodyHash: string;
}

export interface PaymentTerms {
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
}

export interface Quote {
  readonly quoteId: string;
  readonly validUntil: number;
}

export interface SellerKey {
  readonly sellerId: string;
  readonly secret: string | Uint8Array;
}

/** sha256 of the canonical JSON body ('' when there is none). */
export function bodyHashOf(body: unknown): string {
  return sha256Hex(body === undefined ? '' : canonical(body));
}

export function newQuote(now: number, ttlSeconds: number): Quote {
  return { quoteId: newQuoteId(), validUntil: now + ttlSeconds };
}

export function offerBinding(
  seller: SellerKey,
  scheme: string,
  quote: Quote,
  request: RequestFacts,
  terms: PaymentTerms,
): string {
  return computeBinding(seller.secret, {
    sellerId: seller.sellerId,
    scheme,
    quoteId: quote.quoteId,
    validUntil: quote.validUntil,
    method: request.method,
    url: request.url,
    bodyHash: request.bodyHash,
    network: terms.network,
    asset: terms.asset,
    amount: terms.amount,
    payTo: terms.payTo,
  });
}

/**
 * The operation independent of the quote (method, URL, body, price, payee):
 * what a payment-identifier is bound to.
 */
export function operationFingerprint(request: RequestFacts, terms: PaymentTerms): string {
  return sha256Hex(
    canonical({
      method: request.method.toUpperCase(),
      url: request.url,
      body: request.bodyHash,
      network: terms.network,
      asset: terms.asset,
      amount: terms.amount,
      payTo: terms.payTo,
    }),
  );
}
