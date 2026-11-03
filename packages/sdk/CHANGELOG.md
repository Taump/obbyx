# @obbyx/sdk

## 0.1.1

### Patch Changes

- Fixes for payments that could be missed or processed twice.

  - exact: a unit the facilitator posted is no longer expired at the end of the publication window while it may still land (looked for 24 h, never re-posted); a hub timeout before the claim answers `settlement_pending`; every poll rotates the record in the recovery queue.
  - batch-settlement: on watcher reconnect every still-pending voucher is re-delivered (a stored voucher whose ack was lost no longer blocks its channel); a channel the seller is closing refuses new vouchers (`channel_closing`); a settle answer is applied only to the voucher of the same offer.
  - New `KeyedQueue` utility (per-key serial execution).
  - sdk: a refused payment carries an explicit PAYMENT-RESPONSE so the buyer releases its budget and channel voucher; a concurrent refused retry no longer drops a settling payment (`ConsumedProofsStore.markSettled`); `ObyteExactServer` keeps a settled payment usable when the handler failed and recovers a crashed `serving` claim (`servingLeaseSeconds`).

  BREAKING (x402-obyte ports): `SettlementStore` requires `touch(key)`, `BatchStore` requires `pending(payTo)`, `WatcherGateway.health` takes an optional channel address and may return `closing: true`.

- Updated dependencies
  - @obbyx/x402-obyte@0.2.0

## 0.1.0

### Minor Changes

- First public release: x402 `exact` and `batch-settlement` for Obyte (testnet-ready), seller paywall and official-server adapter, paying fetch with budgets, `obbyx` CLI.

### Patch Changes

- Updated dependencies
  - @obbyx/obyte@0.1.0
  - @obbyx/x402-obyte@0.1.0
