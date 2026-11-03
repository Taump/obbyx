/** Seller-side defaults shared by ObytePaywall and ObyteExactServer (seconds). */
export const DEFAULT_QUOTE_TTL_SECONDS = 300;
/** Freshness window of the payment unit's timestamp offered in `maxTimeoutSeconds`. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** How long a request may hold a payment in `serving` before a retry takes it over. */
export const DEFAULT_SERVING_LEASE_SECONDS = 300;
