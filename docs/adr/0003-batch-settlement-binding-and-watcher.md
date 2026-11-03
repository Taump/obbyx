# ADR-0003: `batch-settlement` Obyte binding and the seller watcher

- Status: accepted; watcher implementation chosen 2026-11-03 (option b)
- Date: 2026-11-03

## Context

x402 `batch-settlement` (specs/schemes/batch-settlement) describes
capital-backed, unidirectional channels with cumulative signed vouchers;
`/settle` stores the commitment and does not move value; redemption happens out
of band. The EVM binding has two voucher-management modes; in
**facilitator-managed** mode the facilitator persists the voucher and the
charged cumulative amount, locks per channel (`channel_busy`) and runs claims.

Obyte AA channels map onto it: `amount_spent` ≈ `maxClaimableAmount`; only the
payee (party A) can close with the client's package; the client (B) has an
escape hatch — it can initiate a close itself and confirm after `timeout`.

Known aa-channels-lib hazards:

- feeding a package into `verifyPaymentPackage` after missed intermediate
  packages books the cumulative difference as _overpayment_, which `sweep()`
  then returns to the client;
- `channel_parameters` is not present in every package;
- on `payload.closing` the library auto-confirms if the declared amount is not
  lower than what it knows locally — dangerous if it is behind.

Verified in a local aa-testkit network (`spikes/aa-channel-binding`): the AA
accepts a client-signed package carrying extra fields (`binding`,
`payment_amount`) in a seller-initiated close and pays the seller
`amount_spent` (+10000-byte refund of its `close` bounce fee); changing
`binding` after signing makes the AA reject the package. So `binding` is
covered by the client's signature and can live in `signed_message`.

## Decision

1. Scheme name `batch-settlement`, network binding file
   `scheme_batch_settlement_obyte.md`, error codes
   `invalid_batch_settlement_obyte_*`, **facilitator-managed** mode.
2. Accounting (MVP): unidirectional channel; one in-flight attempt per
   `(network, aa, period)`; next package must satisfy
   `amount_spent == committed + requirements.amount`;
   `payment_amount == requirements.amount`; no overpayment credit. Out-of-order packages are
   rejected (`…_cumulative_amount_mismatch`), concurrent ones get
   `…_channel_busy`.
3. Channel parameters are taken from the **on-chain AA definition**
   (`light/get_definition`) and the address is recomputed; never from
   `channel_parameters` alone.
4. `/settle` response for a voucher: `transaction: ""`, `amount: ""`,
   `extra: {chargedAmount, commitmentId: "<caip2>:<aa>:<period>:<amount_spent>", channelState}`
   — following the EVM binding.
5. **Synchronous durable ack** (user decision): `/settle` succeeds only after the
   seller's watcher has fsynced the package.
   - Journal per seller with a monotonically increasing `seq`.
   - Watcher keeps an outbound authenticated WebSocket, acks `seq` after
     durable write; on reconnect it sends its cursor and the facilitator
     replays from it.
   - No ack within the timeout → `watcher_unavailable`, entry stays `pending`;
     reconciliation either commits it (ack was lost → the payment becomes
     `paid_not_served` for the same binding) or cancels it.
   - Facilitator refuses to verify when the watcher heartbeat is stale or its
     bytes balance for defensive triggers is below the threshold (fail-closed).
6. Watcher implementation — **decided: option (b), own watcher on obyte.js**
   (user decision, 2026-11-03). From aa-channels-lib we reuse the deployed AA,
   the package format, address derivation and the accounting rules, not its
   runtime (ocore + headless wallet). Options considered:
   - (a) aa-channels-lib pinned to a commit with `patch-package`: new
     `importCommittedCommitment(aa, period, amount_spent, pkg)` (sets
     `amount_spent_by_peer`, zero overpayment, monotonic), parameters from the
     on-chain definition, no auto-confirm before the cursor is reconciled,
     fraud proof when the declared amount is lower;
   - (b) own minimal watcher on `@obbyx/obyte` + obyte.js (close / confirm /
     fraud_proof triggers are small and the AA logic is known).
7. Minimum channel `timeout` = max tolerated watcher downtime + dispute margin;
   enforced in `/verify`.

## Implementation notes (2026-11-03)

- **Refusal vs. pending.** A watcher that is not healthy at verification is a
  definite refusal (`…_watcher_unavailable`, nothing stored). A voucher stored
  but not yet acked is `settlement_pending` with `transaction = commitmentId`;
  sellers and buyers retry the SAME voucher. Found by the end-to-end test: one
  code for both made buyers block their channel for nothing.
- **Ack ownership.** `commit(seq, {payTo, network})` checks ownership in the same
  transaction: a watcher can never ack (commit) another seller's voucher.
- **Watcher validation.** The watcher re-verifies each voucher (client signature,
  channel of this seller from the on-chain definition, fields) before storing
  and acking; an invalid voucher is never acked and thus never paid.
- **Hub session.** The watcher's obyte.js client runs a `bootstrap` in
  `onConnect` (watches + push subscription); the heartbeat timer stays outside.
- **Storage.** Facilitator and watcher use Prisma (SQLite); the stores are ports
  with node:sqlite reference implementations; a shared contract suite runs on both.

## Open questions

- The EVM binding says a replayed `/settle` returns `cumulative_amount_mismatch`
  and callers must not auto-retry; our invariant I1 returns the stored result
  for the _same binding_. Either document this as an Obyte-binding rule or
  align with EVM behaviour — resolve in the spec PR discussion.
- Gasless deposit relay has no Obyte equivalent: the client pays its own
  deposit unit.
