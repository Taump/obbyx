# @obbyx/cli

## 0.1.5

### Patch Changes

- Security (buyer): never under-declare on channel close.

  - `ClientChannelStore` tracks `maxSigned`, the highest `amount_spent` signed in the current period; the seller's unauthenticated answers never lower it. Existing databases are migrated on open.
  - `obbyx channel close` declares `maxSigned` instead of the last confirmed amount. Declaring less than any voucher the seller holds let the seller take the whole channel with a fraud proof.
  - `ExactObyteClient` refuses offers valid for more than `maxQuoteTtlSeconds` (default 3600) with `quote_too_long`: a far-future `validUntil` could lock the wallet's coins.
  - `canonical()` sorts keys by code units instead of `localeCompare` (no ICU dependency). Binding HMACs and package hashes are unchanged (pinned by golden vectors); request-body hashes may differ for some key sets.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @obbyx/x402-obyte@0.3.0
  - @obbyx/obyte@0.2.0
  - @obbyx/sdk@0.3.0

## 0.1.4

### Patch Changes

- Fix `error: unable to determine transport target for "pino-pretty"` when the CLI runs in a terminal after `npm i @obbyx/cli`.

  - cli: depends on `pino-pretty` and builds the formatter itself; its logs always go to stderr (stdout carries the command's result).
  - obyte: `createLogger({ pretty: true })` / `LOG_PRETTY=1` falls back to JSON with one warning when the optional `pino-pretty` package is not installed, instead of throwing.

- Updated dependencies
  - @obbyx/obyte@0.1.2

## 0.1.3

### Patch Changes

- af8866b: Internal refactoring without behaviour changes: unit validation, ledger checks, the paywall, `payingFetch`, both client mechanisms, the channel facilitator and the CLI `doctor` / `channel` / `pay` commands are split into small named steps (same checks, same order, same reason codes).

  - x402-obyte: new `parseBalances` reads `light/get_balances` with a schema (a malformed hub answer is `undefined`, never half-read); `obbyx balance`, `obbyx doctor` and the watcher use it.

- Updated dependencies [af8866b]
  - @obbyx/obyte@0.1.1
  - @obbyx/x402-obyte@0.2.2
  - @obbyx/sdk@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies [0284d2b]
  - @obbyx/sdk@0.2.0
  - @obbyx/x402-obyte@0.2.1

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
  - @obbyx/sdk@0.1.1

## 0.1.0

### Minor Changes

- First public release: x402 `exact` and `batch-settlement` for Obyte (testnet-ready), seller paywall and official-server adapter, paying fetch with budgets, `obbyx` CLI.

### Patch Changes

- Updated dependencies
  - @obbyx/obyte@0.1.0
  - @obbyx/x402-obyte@0.1.0
  - @obbyx/sdk@0.1.0
