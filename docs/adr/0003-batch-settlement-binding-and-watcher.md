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

Verified in a local aa-testkit network (`aa/test/test_obbyx_binding.oscript.js`): the AA
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
   - No ack within the timeout → `settlement_pending`, entry stays `pending`;
     reconciliation either commits it (ack was lost → the payment becomes
     `paid_not_served` for the same binding) or cancels it (nack).
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

- **Missed / duplicated work (pre-merge research).** Reconnect re-delivers all
  pending entries, not only `seq > cursor` (a stored-but-unacked voucher stayed
  pending forever). A seller close is announced to the facilitator before it is
  sent, so no voucher is accepted after the close fixed `sentByPeer`. An honest
  client close is confirmed after a grace period (vouchers in flight first).
  Channel defence is serialized per channel (a push and the poll pass sent the
  same trigger twice). A refusal before settlement carries an explicit
  PAYMENT-RESPONSE so the client releases its pending voucher.

- **Refusal vs. pending.** A watcher that is not healthy at verification is a
  definite refusal (`…_watcher_unavailable`, nothing stored). A voucher stored
  but not yet acked is `settlement_pending` with `transaction = commitmentId`;
  sellers and buyers retry the SAME voucher. Found by the end-to-end test: one
  code for both made buyers block their channel for nothing.
- **Ack ownership.** `commit(seq, {payTo, network, packageHash})` checks ownership in
  the same transaction: a watcher can never ack (commit) another seller's voucher.

## Signed receipts (2026-11-05)

A bare `{type: 'ack', seq}` could be forged by anyone relaying the socket: the
facilitator would report a voucher paid that the watcher never stored. ack and
nack now carry a `receipt`, an Obyte signed message by the seller over
`{purpose: 'obbyx-watcher-ack' | 'obbyx-watcher-nack', network, seq, packageHash[, reason]}`
(`packageHash` = sha256 of the canonical package, `packageHashOf`).

- The facilitator verifies the signer is the session's seller and the seq, then
  `commit` / `cancel` apply it atomically only if seller, network AND
  `packageHash` match the journal entry. A receipt for another package under
  the same seq (journal reset) changes nothing.
- **nack** (`pending → cancelled`, final): the watcher definitely refuses a
  voucher (bad signature or fields, channel of another seller or client,
  cumulative amount not raised). The channel's `pendingSeq` is released;
  settle/verify of that voucher answer `invalid_batch_settlement_obyte_voucher_refused`
  (definite: the client drops it and signs a new one for its next payment).
  Cancelled entries are never replayed.
- A nack is sent ONLY for reasons intrinsic to the client-signed package and
  the on-chain channel. The receipt signs `{seq, packageHash}`, not the rest of
  the commitment envelope, so an envelope that disagrees with its package
  (network, amounts, aa…) gets no answer and an `INVARIANT ALERT`; otherwise a
  relay could alter the envelope and obtain a genuine nack for a valid voucher.
  A package the watcher already stored is acked whatever seq it arrives under.
- **Protocol version.** `hello` carries `protocol: 2`; the facilitator refuses
  any other version at login with a clear error. Upgrade the facilitator
  first: until the watcher is upgraded, channel payments fail closed (buyers
  fall back to `exact`); an old facilitator would drop a new watcher on its
  first nack.
- No answer at all for a transient problem (the watcher's hub is unreachable
  or does not know the channel yet) or a seq conflict (needs the operator):
  the entry stays `pending` and is replayed.
- `committed` and `cancelled` are final: a later ack never revives a cancelled
  entry, a later nack never undoes a commit.
- Not covered yet: binding the login to the facilitator's origin (a relaying
  facilitator can still log in as the seller and read its vouchers; it can no
  longer make anyone report them paid).
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
