# @obbyx/x402-obyte

## 0.2.2

### Patch Changes

- af8866b: Internal refactoring without behaviour changes: unit validation, ledger checks, the paywall, `payingFetch`, both client mechanisms, the channel facilitator and the CLI `doctor` / `channel` / `pay` commands are split into small named steps (same checks, same order, same reason codes).

  - x402-obyte: new `parseBalances` reads `light/get_balances` with a schema (a malformed hub answer is `undefined`, never half-read); `obbyx balance`, `obbyx doctor` and the watcher use it.

- Updated dependencies [af8866b]
  - @obbyx/obyte@0.1.1

## 0.2.1

### Patch Changes

- 0284d2b: - sdk: `ObyteBatchServer` registers channel payments (`batch-settlement`) on the official x402 resource server (`@x402/express`, `@x402/core/server`); `ObyteExactServer` and it share `ObyteSchemeServer`.
  - sdk: `ObytePaywall` CORS for browser clients (x402 HTTP transport): option `cors` and `paywall.preflight()`; `Access-Control-Expose-Headers` is now merged with an existing value instead of replacing it.
  - x402-obyte: `BatchObyteClient` confirms or releases its voucher from the official client's `onPaymentResponse` hook, so it works with `@x402/fetch`.

## 0.2.0

### Minor Changes

- Fixes for payments that could be missed or processed twice.

  - exact: a unit the facilitator posted is no longer expired at the end of the publication window while it may still land (looked for 24 h, never re-posted); a hub timeout before the claim answers `settlement_pending`; every poll rotates the record in the recovery queue.
  - batch-settlement: on watcher reconnect every still-pending voucher is re-delivered (a stored voucher whose ack was lost no longer blocks its channel); a channel the seller is closing refuses new vouchers (`channel_closing`); a settle answer is applied only to the voucher of the same offer.
  - New `KeyedQueue` utility (per-key serial execution).
  - sdk: a refused payment carries an explicit PAYMENT-RESPONSE so the buyer releases its budget and channel voucher; a concurrent refused retry no longer drops a settling payment (`ConsumedProofsStore.markSettled`); `ObyteExactServer` keeps a settled payment usable when the handler failed and recovers a crashed `serving` claim (`servingLeaseSeconds`).

  BREAKING (x402-obyte ports): `SettlementStore` requires `touch(key)`, `BatchStore` requires `pending(payTo)`, `WatcherGateway.health` takes an optional channel address and may return `closing: true`.

## 0.1.0

### Minor Changes

- First public release: x402 `exact` and `batch-settlement` for Obyte (testnet-ready), seller paywall and official-server adapter, paying fetch with budgets, `obbyx` CLI.

### Patch Changes

- Updated dependencies
  - @obbyx/obyte@0.1.0
