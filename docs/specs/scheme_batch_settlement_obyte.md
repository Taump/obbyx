# Scheme: `batch-settlement` on Obyte

## Summary

Obyte binding of `batch-settlement` over the AA payment-channel base agent
**v1.2** `7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR` (`aa/channels_base_aa_1.2.oscript`:
our fork of the aa-channels-lib v1.1 base AA with the fraud-proof payout going
to the wronged party; deployed on testnet, not yet on mainnet, so the binding
works on `obyte:testnet` only for now), **facilitator-managed** voucher mode,
x402 v2 only. Channels on the earlier v1.1 base AA
`4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` MUST NOT be paid into.

The client (channel party B) deposits once into a channel AA with the seller
(party A). Each request is paid with a **voucher**: a package signed by the
client for the cumulative amount spent in the current channel period. Nothing
goes on-chain per request. `/settle` records the voucher and succeeds only
after the seller's **watcher** acknowledged a durable write; the watcher later
redeems the best voucher on-chain. Trust model: **capital-backed** (the
deposit is locked in the AA) plus the **watcher-liveness** assumption below.

## Network Identifiers

`obyte:livenet` (mainnet) and `obyte:testnet`. The `obyte` CAIP-2 namespace is
not registered with ChainAgnostic; facilitators advertise the family `obyte:*`.
`network` MUST be the CAIP-2 id (a v1 name such as `obyte-testnet` is refused
with `invalid_network`). A facilitator serves this scheme only on networks
where the v1.2 base AA is deployed (`CHANNEL_BASE_AA_NETWORKS`: `obyte:testnet`
for now) and refuses it elsewhere with `invalid_network`.

## `PaymentRequirements`

| Field               | Rule                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `scheme`            | MUST be `batch-settlement`                                                      |
| `network`           | `obyte:livenet` / `obyte:testnet`                                               |
| `asset`             | the channel asset (`base` or an allowed asset id)                               |
| `amount`            | price of this request, integer string in the smallest units, ≤ 10^15            |
| `payTo`             | the seller address (party A of the channel)                                     |
| `extra.binding`     | HMAC binding of this offer to one request (as in `exact`)                       |
| `extra.quoteId`     | random offer id                                                                 |
| `extra.validUntil`  | unix seconds; a NEW voucher MUST be refused after it                            |
| `extra.baseAa`      | MUST be `7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR` (v1.2)                               |
| `extra.minTimeout`  | minimum channel dispute window the seller accepts, seconds                      |
| `extra.paymentFlow` | `"upfront"` when present; `"escrow"` and `assetTransferMethod` MUST be rejected |

**Pricing.** This binding charges a fixed price: `payment_amount` MUST equal
`amount` and the charge equals the price. Dynamic pricing (commit up to
`amount`, charge less) is not supported in this version; a seller that needs
it offers separate routes.

```json
{
  "scheme": "batch-settlement",
  "network": "obyte:testnet",
  "asset": "base",
  "amount": "20000",
  "payTo": "AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "f0f0…f0",
    "quoteId": "hCqM06Z6HeK59fTBQm5rFg",
    "validUntil": 1793733110,
    "baseAa": "7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR",
    "minTimeout": 3600
  }
}
```

## 1. Commitment format

`PaymentPayload.payload = { "signedPackage": <Obyte signed message> }`, signed
by channel party B for the network:

```json
{
  "signedPackage": {
    "signed_message": {
      "aa_address": "<channel AA>",
      "period": 1,
      "amount_spent": 40000,
      "payment_amount": 20000,
      "binding": "<extra.binding>"
    },
    "authors": [
      { "address": "<B>", "definition": ["sig", { "pubkey": "…" }], "authentifiers": { "r": "…" } }
    ],
    "version": "4.0t"
  }
}
```

`signed_message` MUST contain exactly these fields; amounts MUST be positive
integers ≤ 10^15 (Oscript keeps 15 significant digits; above that the AA's
arithmetic on the voucher is not exact). The base AA accepts the extra
`payment_amount` and `binding` fields (verified with aa-testkit); `binding` is
covered by the signature.

**Package profile.** The AA checks a voucher with ocore's
`is_valid_signed_package`, and a voucher it rejects can never be used in a
close or a fraud proof. The profile below is a strict **subset** of what that
check accepts (it also allows e.g. multi-signature authors, a definition
omitted for an address already defined, or a `last_ball_unit` for a new
address); anything outside the subset is refused even if the AA would accept
it. The package MUST have exactly the top-level
keys `signed_message`, `authors`, `version` (no `timestamp`, no
`last_ball_unit`: the latter makes the check fail for a payer whose address is
already defined); `version` MUST be `2.0`–`4.0` (`t` suffix on testnet), not
`1.0`; one author with a `["sig", {pubkey}]` definition. Anything else is
refused with `…_voucher_signature`, even if the signature is valid.

## 2. Verification

1. requirements well-formed; `accepted` equals the requirements; the asset is allowed;
2. the package has the AA profile above and its signature verifies for the network; the signer is party B;
3. `binding` equals `extra.binding`; `payment_amount` equals `amount`;
4. the channel AA definition is read **from the ledger** and its address recomputed; it MUST be an instance of the v1.2 base AA (a v1.1 channel is refused with `…_channel_not_found`); its parameters name `payTo` as A, the signer as B, and `asset`; its timeout is ≥ max(`extra.minTimeout`, facilitator minimum);
5. for a NEW voucher only: the offer is alive; the channel is in the voucher's `period` and not closing; `amount_spent` ≤ the confirmed deposit (`balanceB` MUST be a safe integer, else `…_ledger_unavailable`); the seller's watcher is online (heartbeat) and holds enough bytes for defensive triggers (fail-closed);
6. accounting: `amount_spent == committed + amount`, where `committed` is the last committed voucher of this channel and period; at most one voucher in flight per channel.

A voucher that is already stored skips step 5 (offer expiry, watcher health,
balance): its outcome is decided by the watcher's ack, and refusing it would
report a definite failure for a voucher the seller may still redeem. Instead:

- **committed**: replayed as success (idempotent), whatever the channel state
  or the current rules, but only for the same operation (`accepted`, binding,
  `payTo`, network, amount, asset);
- **pending**: steps 1–4 apply again (current rules). A definite failure
  there (e.g. `…_channel_timeout` after the facilitator minimum was raised, an
  asset no longer allowed, a legacy channel, an old package shape) cancels the
  entry under the channel lock (`voucher_cancelled` event, the channel is free,
  the voucher is never delivered again) and is answered with that reason;
  if the watcher's ack committed it first, the answer is success. A failure
  that may only reflect the hub (ledger unavailable, AA unknown to the hub) is
  not a refusal (see below). Then the channel period is re-read under the
  channel lock. Only a period that is a number greater than the voucher's
  makes it worthless to the seller: the entry is cancelled (same event) and
  the answer is `…_period_mismatch`. Anything else is not a refusal: a closing channel is
  left to the watcher (it acks during the client's close, nacks once its own
  close is under way); an unreadable ledger, an AA unknown to the hub, a
  missing or lower period (lagging hub) give `/verify` valid and `/settle`
  `settlement_pending` (retry the same voucher). Accepted edge case: if the
  watcher stored a voucher but its ack was lost and the channel then moved to
  a later period, the entry is cancelled and the buyer told
  `…_period_mismatch`, although the seller may have redeemed that voucher in
  the close;
- **cancelled**: refused with `…_period_mismatch` when the ledger shows a
  later period, otherwise with `…_voucher_refused`.

## 3. Storage and commitment identifier

The facilitator appends the voucher to the seller's journal (`pending`,
monotonic `seq`) atomically with the per-channel lock, pushes it to the
seller's watcher, and commits it when the watcher acks it, or cancels it when
the watcher nacks it. Both answers carry a receipt signed by the seller over
`{purpose, network, seq, packageHash}` (`packageHash` = sha256 of the canonical
signed package); the facilitator applies it only for the journal entry of that
seller, network and package. A cancelled voucher is final: it is refused with
`invalid_batch_settlement_obyte_voucher_refused` and frees the channel. Stored
vouchers are encrypted at rest.

`commitmentId = "<network>:<aa>:<period>:<amount_spent>"`. Success:

```json
{
  "success": true,
  "transaction": "",
  "amount": "",
  "payer": "<B>",
  "network": "obyte:testnet",
  "extra": {
    "chargedAmount": "20000",
    "commitmentId": "obyte:testnet:<aa>:1:40000",
    "channelState": {
      "channelId": "<aa>",
      "period": 1,
      "balance": "1000000",
      "chargedCumulativeAmount": "40000"
    }
  }
}
```

**Pending.** Without an ack within the timeout:
`{"success": false, "errorReason": "settlement_pending", "transaction": "<commitmentId>"}`.
Nothing is broadcast in this scheme; `transaction` carries the commitment id
so that the pending answer is non-empty and correlatable. The client retries
the **same** voucher and MUST NOT sign a new one meanwhile. A repeated
`/settle` with the same voucher returns the stored result (an Obyte-binding
rule: the same voucher for the same binding is idempotent).

## 4. Double-spend prevention

- the cumulative rule (`amount_spent == committed + amount`) makes every voucher spend exactly one price;
- one voucher in flight per channel (`…_channel_busy`);
- a voucher is stored once (unique package hash) and bound to one operation (`…_binding_mismatch` for another binding);
- the seller's middleware records each proof so one voucher serves one operation.

## 5. Expiry

A voucher is valid for its channel `period`. A period ends when the channel is
closed (`close` → dispute window → `confirm`); the AA then pays A the
`amount_spent` of the best voucher and returns the rest to B. New vouchers
are refused once a close is initiated. Offers expire at `extra.validUntil`.

## 6. Redemption (seller watcher)

| Channel state                                        | Watcher action                                           |
| ---------------------------------------------------- | -------------------------------------------------------- |
| client started a close declaring less than it signed | `fraud_proof` with the best voucher                      |
| client started an honest close                       | `confirm` after a short grace (vouchers in flight first) |
| seller started the close                             | `confirm` after the dispute window                       |
| enough earned or old enough (policy)                 | announce, then `close` with the best voucher             |

Before a seller close, the watcher **announces** it (`closing` in its
heartbeat); from then on the facilitator refuses new vouchers for the channel
(`…_channel_closing`), and the close is sent after vouchers accepted earlier
were stored — so it carries the final best voucher. On reconnect the
facilitator re-delivers every still-pending voucher of the seller, including
ones below the watcher's cursor (stored but never acked). The facilitator
never sends AA triggers.

## 7. Trust model

- **Capital-backed:** the client's deposit is locked in the AA; a voucher can never exceed it.
- **Watcher liveness:** the channel timeout MUST exceed the longest watcher outage plus a margin, or a client-initiated close could finish before the watcher answers.
- **Watcher latency:** the watcher reacts to a close only once it is stable (can lag 1–2 h), so the facilitator minimum dispute window is at least 3600 s (default 14 400 s).
- **Fraud-proof payout:** the v1.2 base AA pays a fraud proof to the wronged party (the party that did not start the close), whoever submits it. A leaked voucher therefore lets nobody take funds; the facilitator still stores vouchers encrypted and exposes them only to the seller's watcher, now for privacy. (The v1.1 base AA paid whoever submitted the proof; v1.1 channels are no longer paid into.) The facilitator contains no code that sends AA triggers.

## `/supported`

```json
{
  "x402Version": 2,
  "scheme": "batch-settlement",
  "network": "obyte:testnet",
  "extra": {
    "voucherManager": "facilitator",
    "baseAa": "7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR",
    "minTimeout": 3600,
    "assets": ["base"]
  }
}
```

## Error codes

| Code                                                        | Meaning                                                |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `invalid_batch_settlement_obyte_payload`                    | malformed voucher                                      |
| `invalid_batch_settlement_obyte_voucher_signature`          | signature invalid, package not in the AA profile       |
| `invalid_batch_settlement_obyte_channel_not_found`          | AA not defined, or not a v1.2 channel                  |
| `invalid_batch_settlement_obyte_channel_params`             | channel does not connect payer and payTo in this asset |
| `invalid_batch_settlement_obyte_channel_timeout`            | dispute window below the minimum                       |
| `invalid_batch_settlement_obyte_period_mismatch`            | voucher period differs from the channel period         |
| `invalid_batch_settlement_obyte_channel_closing`            | a close is in progress                                 |
| `invalid_batch_settlement_obyte_cumulative_exceeds_balance` | above the confirmed deposit                            |
| `invalid_batch_settlement_obyte_cumulative_amount_mismatch` | not committed + price                                  |
| `invalid_batch_settlement_obyte_payment_amount_mismatch`    | `payment_amount` differs from the price                |
| `invalid_batch_settlement_obyte_binding_mismatch`           | bound to another request or offer                      |
| `invalid_batch_settlement_obyte_asset`                      | asset not allowed                                      |
| `invalid_batch_settlement_obyte_channel_busy`               | another voucher is in flight                           |
| `invalid_batch_settlement_obyte_watcher_unavailable`        | the seller's watcher is offline or underfunded         |
| `invalid_batch_settlement_obyte_ledger_unavailable`         | the hub did not answer (outcome unknown; retry)        |
| `invalid_batch_settlement_obyte_quote_expired`              | the offer expired                                      |

`invalidMessage` / `errorMessage` are diagnostics only.

## Security considerations

- **Replay:** see Double-spend prevention; a voucher settles once and serves one operation.
- **Authorization scope:** the binding ties a voucher to one request and price; the channel parameters tie it to one payer and payee.
- **Settlement atomicity:** append and per-channel lock are one transaction; the commit is a compare-and-set owned by the seller.
