# Architecture

## Packages and apps

```text
packages/
  obyte/        @obbyx/obyte      Obyte primitives: no I/O except the wallet file
    core/         amounts (BigInt), errors, networks (CAIP-2 ids), Verdict result
    unit/         exact-unit profile validator (pure)
    signing/      signed-message (voucher) verification
    channel/      channel AA definition and address
    wallet/       wallet file (zod), shared by CLI, watcher, demo
    logger/ config/
  x402-obyte/   @obbyx/x402-obyte  the x402 mechanisms for Obyte
    hub/          hubCall (timeouts, unknown outcomes), heartbeat, zod schemas of hub answers
    util/         KeyedQueue (per-key serial execution)
    binding/      HMAC binding of a payment to one request
    coins/        coin selection, durable reservations, reserving composer
    exact/        requirements, client, facilitator (+ ledger checks, finality, reasons), v1 adapter, store port
    batch/        requirements, client (+ channel store), facilitator, store port, watcher gateway port/protocol
  sdk/          @obbyx/sdk
    seller/       ObytePaywall, ExactObyteServer / BatchObyteServer (official @x402 servers), CORS, quotes, payment-identifier, consumed proofs
    client/       payingFetch, SpendingBudget
  cli/          @obbyx/cli (obbyx)
    commands/     one file per command (yargs definition + handler)
    lib/          channel, doctor and log-reading logic used by the commands
    faucet/       Obyte device protocol and the testnet faucet
  docs-gen/     generates docs/reference/* from the code
apps/
  facilitator/  HTTP facilitator
    http/         server (wiring), routes/, zod request schemas, error mapping, access guard, OpenAPI
    mechanisms.ts registration of the schemes on the x402 core
    storage/      Prisma stores, package encryption
    watcher/      WebSocket gateway for sellers' watchers
    discovery/    Bazaar catalog
    workers/      recovery of pending settlements
  watcher/      seller watcher: facilitator/ link, chain/ (bootstrap, decide, defender), storage/
  demo/         paid demo API and playground/
```

Dependencies point one way: `obyte` ← `x402-obyte` ← `sdk` ← `cli`; apps
depend on packages, never the other way. The facilitator never imports watcher
code (a CI test enforces it).

## Design patterns

| Pattern                             | Where                                                                                                                                                       | Why                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Strategy** (x402 mechanisms)      | `ExactObyteFacilitator`, `BatchObyteFacilitator`, `ExactObyteClient`, `BatchObyteClient`, `ExactObyteServer`, `BatchObyteServer` registered on `@x402/core` | one interface per role, one class per scheme; new schemes are added without touching the core                                   |
| **Adapter**                         | `ExactObyteFacilitatorV1` (v1 → v2 shapes), `ExactObyteServer` (our binding inside the official server)                                                     | reuse one mechanism for another protocol shape                                                                                  |
| **Ports and adapters**              | `SettlementStore`, `BatchStore`, `WatcherGateway`, `DiscoveryCatalog`                                                                                       | mechanisms know interfaces; node:sqlite reference stores and Prisma stores implement them; one contract test suite runs on both |
| **State machine + compare-and-set** | exact settlements (`claimed → … → stable_good`), consumed proofs (`settling → serving → served`), coin reservations                                         | every transition is atomic, so concurrent requests cannot double-broadcast, double-serve or double-spend coins                  |
| **Idempotency keys**                | `(network, unit hash)`, voucher hash, payment-identifier                                                                                                    | a repeated request returns the stored result                                                                                    |
| **Per-key serial queue**            | `KeyedQueue` (`x402-obyte/src/util`): one voucher per channel in the batch facilitator, one defence per channel in the watcher                              | check-then-act never interleaves for one channel inside a process (the database enforces it across processes)                   |
| **Fail-closed / unknown outcome**   | `hubCall` returns `ok` / `hub_error` / `unknown`; unexpected errors after a claim answer `settlement_pending`                                               | an unknown outcome is never success and never a definite failure that releases funds                                            |
| **Validate at the boundary (zod)**  | HTTP bodies and queries, payment-identifier, hub answers, wallet file, watcher protocol, configuration                                                      | everything untrusted is parsed once; inner code works with typed values                                                         |
| **Builder / composition root**      | `buildMechanisms`, `buildFacilitator`, each app's `main.ts`                                                                                                 | wiring in one place; tests build the same graph with fakes                                                                      |
| **Command**                         | CLI `commands/*`                                                                                                                                            | one definition per command; the CLI reference is generated from them                                                            |

## Invariants (where they are enforced)

| Invariant                                                | Enforced by                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| One payment pays one operation                           | binding HMAC (`binding/`), consumed proofs (`seller/consumed-proofs.ts`)                                    |
| A payment is broadcast at most once                      | settlement claim CAS + in-process in-flight map (`exact/facilitator.ts`)                                    |
| The handler runs at most once per payment                | `paid_not_served → serving` CAS (paywall), `settling → serving` claim in `onBeforeSettle` (official server) |
| A voucher spends exactly one price                       | `amount_spent == committed + price`, one in flight per channel (`batch/store.ts`)                           |
| A stored voucher is never reported as a definite failure | stored vouchers skip live checks and are only re-delivered (`batch/facilitator.ts`)                         |
| No unknown outcome releases money                        | `hubCall` classification, `settleUnexpected`, budgets released only on 402                                  |
| The facilitator never moves channel funds                | no AA triggers in its code (`no-aa-triggers.test.ts`), vouchers encrypted at rest                           |
