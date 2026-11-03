# ADR-0007: Contributing Obyte to x402 upstream

- Status: proposed (needs the maintainers' discussion first)
- Date: 2026-11-03

## Context

The active upstream is **github.com/x402-foundation/x402** (Apache-2.0; the
`coinbase/x402` copy is stale). Its `CONTRIBUTING.md` → "Adding a New Chain
Family" prescribes three PRs:

1. **Spec only**: `specs/schemes/<scheme>/scheme_<scheme>_<chain>.md`, covering
   payload structure, verification and settlement (template:
   `specs/scheme_impl_template.md`).
2. **Reference implementation** in one SDK, after the spec is approved: a new
   mechanisms package (no changes to core) implementing the client, server and
   facilitator interfaces; unit, integration and e2e tests
   (`e2e/config/mechanisms_<chain>.json` + registration in the shared e2e
   modules); examples in `all_networks`; a publishing workflow; a README.
3. **Other SDKs** (Python, Go) afterwards.

All commits must be signed. A mechanism that differs from the EVM reference is
re-audited by the Foundation. Facilitators are listed separately in
`docs/dev-tools/facilitators.md`.

## Decision

| Step | What                                                                                                                                                                                               | Where                                                                                     | When                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| 0    | Discussion: Obyte as a chain family; the unregistered `obyte` CAIP-2 namespace; why `exact` (facilitator-submitted, payer-signed) and `batch-settlement` (AA channels) fit; disclose AI assistance | GitHub issue / Slack                                                                      | first                   |
| 1    | Spec PR **`exact` only**                                                                                                                                                                           | `specs/schemes/exact/scheme_exact_obyte.md` (from our `docs/specs/scheme_exact_obyte.md`) | after the discussion    |
| 2    | Reference implementation of `exact`                                                                                                                                                                | `typescript/packages/mechanisms/obyte` as `@x402/obyte`, Apache-2.0, signed commits       | after spec approval     |
| 3    | Spec PR, then implementation, for `batch-settlement`                                                                                                                                               | `specs/schemes/batch-settlement/scheme_batch_settlement_obyte.md`                         | after `exact` is merged |
| 4    | Listing of a hosted obbyx facilitator                                                                                                                                                              | `docs/dev-tools/facilitators.md`                                                          | independent, any time   |

What stays **out of tree** (in obbyx, MIT): the facilitator app and its
SQLite/Prisma stores, the seller watcher, the CLI, the SDK conveniences
(`ObytePaywall`, `payingFetch`, budgets). Until step 2 merges, sellers and
clients use `@obbyx/x402-obyte` from npm with the official `@x402/*` packages
(this already works: contract tests in `packages/sdk/test/contract-*.test.ts`).

The upstream `@x402/obyte` package is a **slim extract**:

- the mechanism classes (`ExactObyteClient`, `ExactObyteFacilitator`, `ObyteExactServer`) and the pure validation (`validateExactUnit`, `verifySignedPackage`, network ids, amounts);
- no dependency on our workspace packages, no SQLite stores (the facilitator store becomes an interface with an in-memory default), no coin-reservation store (optional hook);
- **no x402 v1** (not required for new chains; less surface to review);
- relicensed Apache-2.0 (we own the code).

## Conformance status (after the pre-merge refactoring)

| Requirement                                                                                                            | Status                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CAIP-2 ids `obyte:livenet` / `obyte:testnet`, documented as unregistered                                               | ✅ spec "Network Identifiers"                                                                                               |
| VerifyResponse / SettleResponse shapes; non-empty `transaction` on `settlement_pending`                                | ✅ (batch: commitment id, explained in the spec)                                                                            |
| No fake network ids in error responses                                                                                 | ✅ (configured default network)                                                                                             |
| Error codes `invalid_<scheme>_<network>_<reason>`                                                                      | ✅; generic seller-side codes (`invalid_payment_reused`, `payment_already_used`) stay in obbyx, not in the upstream package |
| §6.1 payment flows: `paymentFlow` declared; unsupported flow / asset transfer method rejected                          | ✅ (`escrow` and any `assetTransferMethod` rejected)                                                                        |
| `exact` facilitator-submitted family declarations (fee payer, replay primitive, validity window, duplicate submission) | ✅ spec Summary table                                                                                                       |
| Non-empty `extra.splits` rejected                                                                                      | ✅ (strict `extra`)                                                                                                         |
| `batch-settlement` binding: commitment format, verification, storage/id, double-spend, expiry, redemption, trust model | ✅ spec sections 1–7                                                                                                        |
| Dynamic pricing in `batch-settlement`                                                                                  | ⚠️ deviation: fixed price (`payment_amount == amount`), stated in the spec                                                  |
| `EXTENSION-RESPONSES` (bazaar)                                                                                         | ✅ (reported after a successful settle)                                                                                     |
| Three interfaces per mechanism                                                                                         | ✅ `exact`; ❌ `batch-settlement` has no `SchemeNetworkServer` yet (needed before step 3)                                   |
| Upstream-style tests (`test/unit`, `test/integrations`, `e2e/config/mechanisms_obyte.json`)                            | ❌ to be created in the upstream package (ours: unit, contract and e2e with a fake hub, plus live testnet runs)             |
| Browser CORS rules of `transports-v2/http.md`                                                                          | ❓ to check in the seller middleware before step 2                                                                          |

## Consequences

- Our spec files are written in the upstream template and copied as-is for step 1.
- The step-2 package needs an extraction pass (no workspace imports, interfaces instead of SQLite, no v1), plus the upstream test layout.
- The channel trust issue (fraud-proof payout, ADR-0001) must be disclosed in the step-3 discussion; a replacement AA may be requested before acceptance.
