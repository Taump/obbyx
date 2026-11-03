import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonical } from '../exact/requirements.js';

/**
 * Binding of a payment to ONE operation (invariant I1/I2).
 *
 * binding = HMAC-SHA256(sellerSecret, canonical{v, sellerId, scheme, quoteId,
 *           validUntil, method, url, bodyHash, network, asset, amount, payTo})
 *
 * - The client signs the binding into its payment (unit data message), so a
 *   payment cannot be moved to another operation.
 * - The HMAC makes quotes unforgeable without storing them: on the paid
 *   request the seller recomputes it from the request and the quote fields.
 */
export interface BindingInput {
  readonly sellerId: string;
  /** x402 scheme of the offer (a payment of one scheme never counts for another). */
  readonly scheme: string;
  readonly quoteId: string;
  readonly validUntil: number;
  readonly method: string;
  /** Path + query string, as requested. */
  readonly url: string;
  /** sha256 hex of the request body ('' for none), or a custom fingerprint. */
  readonly bodyHash: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
}

export function computeBinding(secret: Uint8Array | string, input: BindingInput): string {
  return createHmac('sha256', secret)
    .update(canonical({ v: 1, ...input, method: input.method.toUpperCase() }))
    .digest('hex');
}

export function bindingsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function newQuoteId(): string {
  return randomBytes(16).toString('base64url');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
