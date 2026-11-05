---
'@obbyx/sdk': minor
'@obbyx/x402-obyte': patch
---

- sdk: `ObyteBatchServer` registers channel payments (`batch-settlement`) on the official x402 resource server (`@x402/express`, `@x402/core/server`); `ObyteExactServer` and it share `ObyteSchemeServer`.
- sdk: `ObytePaywall` CORS for browser clients (x402 HTTP transport): option `cors` and `paywall.preflight()`; `Access-Control-Expose-Headers` is now merged with an existing value instead of replacing it.
- x402-obyte: `BatchObyteClient` confirms or releases its voucher from the official client's `onPaymentResponse` hook, so it works with `@x402/fetch`.
