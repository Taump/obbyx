import type { Request, RequestHandler, Response } from 'express';

/**
 * CORS for browser clients of a paid route (x402 `transports-v2/http.md`,
 * "Browser clients"). None of the x402 headers is CORS-safelisted: without
 * these headers a cross-origin page cannot read the price (402) or send the
 * payment. CORS decides who may READ a response; it is not a payment control.
 */
export interface PaywallCorsOptions {
  /** Allowed origins (exact `scheme://host[:port]`), or `'*'` for any. */
  readonly origins: readonly string[] | '*';
  /** Whether requests may carry credentials (cookies); origins are then reflected, never `*`. */
  readonly credentials?: boolean;
  /** Preflight cache lifetime (default 600 s). */
  readonly maxAgeSeconds?: number;
}

/** Response headers a browser client must read: the price and the settlement. */
export const EXPOSED_HEADERS = ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'] as const;
/** Request headers a browser client sends: the payment, and Content-Type for a JSON body. */
export const ALLOWED_HEADERS = ['PAYMENT-SIGNATURE', 'Content-Type'] as const;
const DEFAULT_MAX_AGE_SECONDS = 600;

/** Merges header names into a comma-separated list, keeping existing ones (case-insensitive). */
export function mergeHeaderList(
  existing: string | number | readonly string[] | undefined,
  add: readonly string[],
): string {
  const current =
    existing === undefined
      ? []
      : (Array.isArray(existing) ? existing.join(',') : String(existing))
          .split(',')
          .map((h) => h.trim())
          .filter((h) => h.length > 0);
  const seen = new Set(current.map((h) => h.toLowerCase()));
  for (const h of add) {
    if (!seen.has(h.toLowerCase())) {
      current.push(h);
      seen.add(h.toLowerCase());
    }
  }
  return current.join(', ');
}

/** Always: lets a cross-origin page read the x402 headers (merged with any value already set). */
export function exposePaymentHeaders(res: Response): void {
  res.setHeader(
    'Access-Control-Expose-Headers',
    mergeHeaderList(res.getHeader('Access-Control-Expose-Headers'), EXPOSED_HEADERS),
  );
}

/** Sets `Access-Control-Allow-Origin` for an allowed calling origin; false when not allowed. */
export function allowOrigin(req: Request, res: Response, cors: PaywallCorsOptions): boolean {
  const origin = req.get('origin');
  if (origin === undefined) return false;
  const anyOrigin = cors.origins === '*';
  if (!anyOrigin && !cors.origins.includes(origin)) return false;
  if (anyOrigin && cors.credentials !== true) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // A reflected origin varies per request: shared caches must key on it.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', mergeHeaderList(res.getHeader('Vary'), ['Origin']));
  }
  if (cors.credentials === true) res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

/**
 * Answers the CORS preflight (`OPTIONS`) of paid routes without requiring
 * payment. Allows the x402 request headers plus whatever else the browser
 * announces: x402 client SDKs have added request headers of their own, and an
 * allow list naming exactly the protocol headers would refuse their retry.
 */
export function preflightHandler(cors: PaywallCorsOptions): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS' || req.get('access-control-request-method') === undefined) {
      next();
      return;
    }
    if (!allowOrigin(req, res, cors)) {
      res.status(204).end(); // no CORS headers: the browser refuses the call
      return;
    }
    const requested = (req.get('access-control-request-headers') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    res.setHeader(
      'Access-Control-Allow-Headers',
      mergeHeaderList(undefined, [...ALLOWED_HEADERS, ...requested]),
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      mergeHeaderList(undefined, [
        req.get('access-control-request-method') ?? 'POST',
        'GET',
        'POST',
      ]),
    );
    res.setHeader('Access-Control-Max-Age', String(cors.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS));
    res.status(204).end();
  };
}
