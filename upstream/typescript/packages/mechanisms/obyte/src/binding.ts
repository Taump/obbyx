import { canonicalJson, constantTimeEqual, hmacSha256Hex, randomId, sha256Hex } from "./utils";

/**
 * What a binding ties a payment to: one offer of one seller for one request.
 *
 * binding = HMAC-SHA256(sellerSecret, canonical({v: 1, sellerId, scheme,
 *           quoteId, validUntil, method, url, bodyHash, network, asset,
 *           amount, payTo}))
 */
export interface BindingInput {
  readonly sellerId: string;
  readonly scheme: string;
  readonly quoteId: string;
  readonly validUntil: number;
  readonly method: string;
  /** Path and query string, as requested. */
  readonly url: string;
  /** SHA-256 hex of the canonical request body (of '' when there is none). */
  readonly bodyHash: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
}

/**
 * Computes the binding of an offer to a request.
 *
 * @param secret - Seller secret (at least 32 bytes).
 * @param input - Offer and request.
 * @returns 64 lowercase hex characters.
 */
export function computeBinding(secret: string | Uint8Array, input: BindingInput): string {
  return hmacSha256Hex(
    secret,
    canonicalJson({ v: 1, ...input, method: input.method.toUpperCase() }),
  );
}

/**
 * Compares two bindings in constant time.
 *
 * @param a - First binding.
 * @param b - Second binding.
 * @returns True when equal.
 */
export function bindingsEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

/**
 * SHA-256 of the canonical JSON body, as used in `bodyHash`.
 *
 * @param body - Parsed request body, or undefined when there is none.
 * @returns Hex digest.
 */
export function bodyHashOf(body: unknown): string {
  return sha256Hex(body === undefined ? "" : canonicalJson(body));
}

/**
 * A fresh offer identifier.
 *
 * @returns Random URL-safe identifier.
 */
export function newQuoteId(): string {
  return randomId();
}
