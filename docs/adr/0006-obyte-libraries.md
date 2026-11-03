# ADR-0006: Obyte libraries

- Status: accepted
- Date: 2026-11-03

## Context

Phase-0 spike on Node 24.22 (darwin-arm64): obyte.js `obyte@0.2.1` (npm) and
ocore 0.4.8 (`github:byteball/ocore`, not published on npm). Both produced
byte-identical results for unit hashes (v3.0t and v4.0t units), signed-message
hashes, signatures and AA addresses (e.g. a known testnet channel instance
`XQJX4Y7HSBXLDX2CP66XSOMRDLJMLQSQ` recomputed from its definition).

## Decision

**obyte.js is used directly — no obbyx wrapper or adapter layers** (user
decision). obbyx code imports `obyte` (`Client`, `utils`) and, where obyte.js
offers no public API, `obyte/lib/internal.js` (hashing, signing, sizes; typed in
`packages/obyte/src/types/obyte-internal.d.ts`). The obyte.js version is pinned
exactly.

| Need                      | obyte.js API                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub reads                 | `client.api.getJoint`, `getDefinition`, `getAaStateVars`, `getLastStableUnitProps`, `getHistory`                                             |
| Broadcast                 | `client.api.postJoint`                                                                                                                       |
| Composing client units    | `client.compose.message('multi', …)` with `client.api.pickDivisibleCoinsForAmount` replaced by our coin picker (input reservation, ADR-0002) |
| Signing packages          | `utils.signMessage(message, { privateKey, testnet })`                                                                                        |
| Hashes, chash, signatures | `utils.getChash160`, `internal.getUnitHash`, `getUnitHashToSign`, `getSignedPackageHashToSign`, `getBase64Hash`, `verify`                    |

`@obbyx/obyte` contains only logic obyte.js does not have: network-bound
signed-package verification with reason codes, channel address derivation and
parsing, the `exact` unit profile validator (including commission checks on
signed units), amounts, networks, logging and config.

ocore is a dev-only reference (not on npm; `signed_message.js` needs a DB). The
facilitator never loads ocore. aa-channels-lib (watcher option a) keeps its own
ocore stack isolated in `apps/watcher`.

## Facts that shape call sites

- obyte.js requests have **no timeout**. Payment code applies its own timeout
  at the call site.
- obyte.js rejects with the hub's error value (a string) for definite hub
  errors and with an `Error` for transport failures (connection closed). A
  transport failure or timeout on `postJoint` is an **unknown outcome**: the
  unit may have been accepted; it must be resolved with `getJoint` (I7).
- `get_last_stable_unit_props` returns `{unit, main_chain_index, timestamp}`;
  there is no ball (checked live, `test/ledger.live.test.ts`).
- `get_joint` answers `joint_not_found` as a success response; the unit object
  carries `main_chain_index`, which is not part of the hashed content.

## Consequences

- Deep imports of obyte.js internals are a maintenance risk; conformance tests
  on real testnet ledger data (`test/conformance.test.ts`) and the live hub
  test catch drift on upgrade.
