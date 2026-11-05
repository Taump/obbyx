# @obbyx/obyte

## 0.1.2

### Patch Changes

- Fix `error: unable to determine transport target for "pino-pretty"` when the CLI runs in a terminal after `npm i @obbyx/cli`.

  - cli: depends on `pino-pretty` and builds the formatter itself; its logs always go to stderr (stdout carries the command's result).
  - obyte: `createLogger({ pretty: true })` / `LOG_PRETTY=1` falls back to JSON with one warning when the optional `pino-pretty` package is not installed, instead of throwing.

## 0.1.1

### Patch Changes

- af8866b: Internal refactoring without behaviour changes: unit validation, ledger checks, the paywall, `payingFetch`, both client mechanisms, the channel facilitator and the CLI `doctor` / `channel` / `pay` commands are split into small named steps (same checks, same order, same reason codes).

  - x402-obyte: new `parseBalances` reads `light/get_balances` with a schema (a malformed hub answer is `undefined`, never half-read); `obbyx balance`, `obbyx doctor` and the watcher use it.

## 0.1.0

### Minor Changes

- First public release: x402 `exact` and `batch-settlement` for Obyte (testnet-ready), seller paywall and official-server adapter, paying fetch with budgets, `obbyx` CLI.
