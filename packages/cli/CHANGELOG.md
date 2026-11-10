# @obbyx/cli

## 0.2.0

### Minor Changes

- efad172: Payment channels move to base AA v1.2 (`7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR`), where a fraud proof pays the wronged party instead of whoever submits it. In v1.1 (`4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`) a client could close declaring less than it spent and then "prove" its own lie to take the whole channel back.

  - obyte: `CHANNEL_BASE_AA` is v1.2; `LEGACY_CHANNEL_BASE_AAS` lists v1.1. `parseChannelDefinition` accepts only v1.2, while `parseAnyChannelDefinition` also recognises legacy channels so they can still be closed. `channelAddress`/`channelDefinition` take an optional base AA.
  - obyte: `verifyVoucherPackage` (the `'aa'` profile of `verifySignedPackage`) accepts only the package shape that the AA's `is_valid_signed_package` accepts: the keys `signed_message`, `authors` and `version`, with version 2.0–4.0. The facilitator and watcher use it, so a voucher that could never be used on-chain is never accepted as a payment.
  - x402-obyte (facilitator): a stored pending voucher is checked against the channel state again when it is retried. Voucher amounts are capped at 10^15.
  - x402-obyte (client), breaking:
    - `closeChannel(options, aa, { declare?, force?, resend? })` declares the highest amount signed for the on-chain period and stops signing durably before it broadcasts.
    - `confirmClose(options, aa)` reads the on-chain state.
    - `deposit` is async and refuses while a close is pending, and for a channel that is not in the store.
    - Signing needs a `maxAmount` for the asset.
    - Channels on a legacy base AA are never paid into.
    - A retried operation resends its pending voucher on the channel that holds it and never signs on another one; a new operation skips a channel whose voucher is pending. `ClientChannelStore.attachPaymentHeader` takes the channel address.
    - A pending voucher no longer blocks closing. Its payment payload and retry header are recorded when it is signed, on every path (`payingFetch` and the official `@x402/fetch`/`@x402/axios` clients, through `schemeHooks.onAfterPaymentCreation`).
    - The channel database keeps a never-deleted per-period history (`client_periods`): the highest voucher signed, every close declared, and whether more may have been signed than is known (a channel migrated from an older version, or recovered). Nothing a hub reports can lower it. Closing an uncertain period needs `declare` or `force`.
    - A close records what became of its unit (`lastClose.state`: `prepared` / `unknown` / `posted` / `rejected`). A close that was never sent, or that the hub rejected, is sent again by the next `closeChannel` without `resend`. A repeated close can raise the declaration, never lower it below an earlier one that may have been sent. A close whose declaration another process replaced before it was posted is not broadcast (`close_superseded`). No voucher is signed for a period once its close was started.
    - New `recoverChannels`. Recovered channels are uncertain in every period: closing one needs `declare` or `force`.
    - The channel database records its schema version (`PRAGMA user_version`) and refuses one written by a newer version.
  - Renamed (breaking): `ObyteExactServer` → `ExactObyteServer`, `ObyteBatchServer` → `BatchObyteServer`, `ObyteExactServerOptions` → `ExactObyteServerOptions`, `ObyteBatchServerOptions` → `BatchObyteServerOptions`, `BatchClientOptions` → `BatchObyteClientOptions`. All mechanism classes now follow `<Scheme>Obyte<Role>`.
  - cli: `channel close` has `--declare`, `--force` and `--resend`. New `channel recover`, which warns that closing a recovered channel needs `--declare` or `--force`. Legacy channels are flagged. `channel status` shows uncertainty and the close state. `pay` prints the retry header whenever the outcome is unknown.

  Upgrade notes:

  - **Do not downgrade** after running this version. An older obbyx sharing the same `$OBBYX_HOME` channel database ignores the closing mark and the per-period history: it could sign vouchers above a declaration already sent, and the seller would then take the whole deposit. Older versions do not check the schema version, so nothing stops them.
  - Earlier versions trusted the period a hub reported, and reset the highest signed amount when a hub reported a later period, so they may have lost track of vouchers they signed. The current period of every channel in a database written by an earlier version is therefore marked uncertain: close it with `obbyx channel close <aa> --declare <the highest amount you believe you signed>` (or `--force` to declare the highest known amount).
  - Settle or close pending vouchers created before this upgrade _before_ upgrading the facilitator and the watcher. A voucher accepted under the old, looser package profile, or one on a v1.1 channel, is refused when it is retried.

### Patch Changes

- Updated dependencies [efad172]
  - @obbyx/obyte@0.3.0
  - @obbyx/x402-obyte@0.4.0
  - @obbyx/sdk@0.4.0

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
