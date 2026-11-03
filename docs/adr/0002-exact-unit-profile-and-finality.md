# ADR-0002: `exact` scheme — supported unit profile and finality

- Status: accepted (MVP); to be confirmed by testnet runs in phase 3
- Date: 2026-11-03

## Context

In the `exact` scheme the client composes and signs an Obyte unit but does not
broadcast it; the facilitator verifies it and broadcasts it in `/settle`
(x402 "facilitator-submitted" family). A signed-message verifier (as in
aa-channels-lib) is not a unit validator: a unit has inputs, fees, parents,
author definitions and asset rules.

Phase-0 spike facts (obyte.js 0.2.1, ocore 0.4.8 @ 24e83dbd, testnet hub):

- obyte.js composes and signs without broadcasting
  (`client.compose.message('multi', …)`), and broadcasts separately
  (`api.postJoint`). A `data` message can accompany the `payment`.
- Coins are picked by the hub (`light/pick_divisible_coins_for_amount`); there
  is no reservation API. Concurrent composes from one address may pick the same
  outputs.
- The light API exposes **no `is_stable` / `sequence` fields**.
  - Stable (hub-trusted): `unit.main_chain_index ≤ last_stable_mci`
    (`get_joint` + `get_last_stable_unit_props`).
  - Stable (proof-based): the unit's ball appears in `light/get_history`
    `proofchain_balls`; `is_nonserial: true` there means **final-bad**.
  - temp-bad is only pushed (`light/sequence_became_bad`) to clients watching
    the address; unstable bad units are absent from history.

## Decision

### Supported profile

Anything else is rejected with `invalid_exact_obyte_unsupported_unit`.

| Check                                                                                                                               | Source                            | Trust boundary |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| Structure, unit hash, size ≤ limit                                                                                                  | local (obyte.js hashing)          | —              |
| Exactly one author, definition `['sig', {pubkey}]` (in the unit or fetched)                                                         | local + hub for known definitions | hub            |
| Author signature                                                                                                                    | local                             | —              |
| Messages: `payment` in bytes or an allowlisted public divisible asset, plus exactly one `data` message `{x402: {binding, quoteId}}` | local + config allowlist          | config         |
| Exactly one output of `amount` to `payTo`; `payTo` is not an AA (MVP); no facilitator address debited                               | local                             | —              |
| Inputs exist and are unspent; amounts and fees balance                                                                              | hub                               | hub            |
| `last_ball` recent (acceptance window, see below)                                                                                   | hub                               | hub            |
| After broadcast: MCI vs last stable MCI, nonserial flag                                                                             | hub                               | hub            |

### Finality policies

Verified against the live testnet hub (2026-11-03):

- A unit is **stable and proven** when its ball appears in `proofchain_balls`
  of `light/get_history` with `requested_joints: [unit]`. `is_nonserial: true`
  on that ball means **final-bad** (double spend); otherwise it is good
  (ocore `light.js` processHistory). Absent ball → not stable yet.
- `addresses` is mandatory for `light/get_history`; we pass an address with no
  history (chash of a constant definition nobody can sign for,
  `HISTORY_PROBE_ADDRESS`), so the response stays small (~160 ms on testnet).
- `get_last_stable_unit_props` returns `{unit, main_chain_index, timestamp}`
  (no ball).
- The hub builds a proofchain only for units with MCI ≤ the `last_ball_mci` of
  its witness proof (ocore `light.js prepareHistory`). A unit can therefore be
  stable (MCI ≤ last stable MCI, returned with a ball) for a while before it is
  _provable_. Observed in the first live testnet payment (unit `dosjqlzx…`,
  2026-11-03): accepted 16:28:03, stable by MCI ~16:32:50, proven 16:33:59. We
  require the proof (as Obyte light wallets do). Stabilization speed depends on
  traffic: with few transactions the stable point normally lags up to ~2 hours
  (on testnet and on a quiet mainnet); under load it is minutes.

Policies:

- `stable` (default; the only policy for `upfront` routes in phase 3): success
  only when the unit is proven stable and good.
- `accepted` (opt-in, "risk on seller"): success once the network accepted the
  unit; the facilitator keeps tracking it to `stable_good` / `final_bad`.
- Until the policy is met `/settle` returns `settlement_pending` with
  `transaction = <unit hash>` (always non-empty; the hash is deterministic
  before broadcast). Repeated calls resume, never rebroadcast after the
  publication window.

### Settlement state machine (implemented in `@obbyx/x402-obyte`)

`claimed → broadcasting → accepted → stable_good | final_bad`, plus terminal
`rejected` (definite hub error and the unit is unknown) and `expired`
(publication window closed, unit never seen on the ledger). The row is written
before broadcast; a lost `post_joint` response leaves `broadcasting`, resolved
by `get_joint` on the next attempt or by the recovery worker after restart.

### Time windows (kept separate)

- quote validity: `extra.quote = {id, validUntil}` signed by the seller;
- HTTP request window: middleware timeouts;
- proof acceptance: quote alive, unit timestamp within `maxTimeoutSeconds`
  (+ clock skew), and `last_ball` not older than `MAX_LAST_BALL_AGE_SECONDS`
  (default 10800 = 3 h) — _local policies_, not an expiry of the signature.
  Update 2026-11-03: the last-ball limit was first tied to `maxTimeoutSeconds`;
  on testnet the stable point lagged 66–77 minutes (normal with few
  transactions; up to ~2 h is expected) and every payment was refused.
  The limit is now separate: the unit's freshness is already guaranteed by the
  offer binding (it contains a random `quoteId` issued at most the quote TTL
  ago), so the last-ball age only bounds how stale the ledger view may be;
- publication: an Obyte unit never expires. The facilitator does not publish
  after the acceptance window and deletes unpublished proofs after retention.
  The SDK reserves inputs per payment (own coin picker injected into obyte.js)
  and, after the window, either cancels by spending the same inputs to itself
  or releases them only after confirming the unit never appeared.

## Consequences

- obyte.js internal hashing helpers are wrapped in one adapter with a pinned
  version; ocore is a dev-only dependency for conformance tests (it is not on
  npm and `signed_message.js` needs a DB).
- A leaked unpublished unit can be published by anyone and pays the seller the
  signed amount without service; documented in the scheme spec.
