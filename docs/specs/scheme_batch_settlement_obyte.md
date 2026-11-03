# Scheme: `batch-settlement` on Obyte

## Summary

Obyte binding of `batch-settlement` over the deployed AA payment-channel base
agent `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` (aa-channels-lib v1.1, identical on
mainnet and testnet), **facilitator-managed** voucher mode, x402 v2 only.

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

## `PaymentRequirements`

| Field               | Rule                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `scheme`            | MUST be `batch-settlement`                                                      |
| `network`           | `obyte:livenet` / `obyte:testnet`                                               |
| `asset`             | the channel asset (`base` or an allowed asset id)                               |
| `amount`            | price of this request, integer string in the smallest units                     |
| `payTo`             | the seller address (party A of the channel)                                     |
| `extra.binding`     | HMAC binding of this offer to one request (as in `exact`)                       |
| `extra.quoteId`     | random offer id                                                                 |
| `extra.validUntil`  | unix seconds; a NEW voucher MUST be refused after it                            |
| `extra.baseAa`      | MUST be `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`                                      |
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
    "baseAa": "4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ",
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
    "authors": [{ "address": "<B>", "authentifiers": { "r": "…" } }],
    "last_ball_unit": "…",
    "version": "4.0t"
  }
}
```

`signed_message` MUST contain exactly these fields; amounts MUST be safe
integers (≤ 2^53 − 1). The base AA accepts the extra `payment_amount` and
`binding` fields (verified with aa-testkit); `binding` is covered by the
signature.

## 2. Verification

1. requirements well-formed; `accepted` equals the requirements; the asset is allowed;
2. the package signature verifies for the network; the signer is party B;
3. `binding` equals `extra.binding`; `payment_amount` equals `amount`;
4. the channel AA definition is read **from the ledger** and its address recomputed; its parameters name `payTo` as A, the signer as B, and `asset`; its timeout is ≥ max(`extra.minTimeout`, facilitator minimum);
5. for a NEW voucher only: the offer is alive; the channel is in the voucher's `period` and not closing; `amount_spent` ≤ the confirmed deposit; the seller's watcher is online (heartbeat) and holds enough bytes for defensive triggers (fail-closed);
6. accounting: `amount_spent == committed + amount`, where `committed` is the last committed voucher of this channel and period; at most one voucher in flight per channel.

A voucher that is already stored skips step 5 and is only re-delivered (its
outcome is decided by the watcher's ack; refusing it would report a definite
failure for a voucher the seller may still redeem).

## 3. Storage and commitment identifier

The facilitator appends the voucher to the seller's journal (`pending`,
monotonic `seq`) atomically with the per-channel lock, pushes it to the
seller's watcher, and commits it when the watcher acks `seq` (the ack is
ownership-checked: a watcher acks only its own seller's vouchers). Stored
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
- a voucher is stored once (unique package hash) and bound to one operation (`invalid_payment_reused` for another binding);
- the seller's middleware records each proof so one voucher serves one operation.

## 5. Expiry

A voucher is valid for its channel `period`. A period ends when the channel is
closed (`close` → dispute window → `confirm`); the AA then pays A the
`amount_spent` of the best voucher and returns the rest to B. New vouchers
are refused once a close is initiated. Offers expire at `extra.validUntil`.

## 6. Redemption (seller watcher)

| Channel state                                        | Watcher action                      |
| ---------------------------------------------------- | ----------------------------------- |
| client started a close declaring less than it signed | `fraud_proof` with the best voucher |
| client started an honest close                       | `confirm`                           |
| seller started the close                             | `confirm` after the dispute window  |
| enough earned or old enough (policy)                 | `close` with the best voucher       |

The facilitator never sends AA triggers.

## 7. Trust model

- **Capital-backed:** the client's deposit is locked in the AA; a voucher can never exceed it.
- **Watcher liveness:** the channel timeout MUST exceed the longest watcher outage plus a margin, or a client-initiated close could finish before the watcher answers.
- **Fraud-proof payout:** the deployed base AA pays a fraud proof to whoever submits it. A holder of a voucher with a higher `amount_spent` than the client declared in a close could take the channel balance. The facilitator therefore stores vouchers encrypted, exposes them to no one but the seller's watcher, and contains no code that sends AA triggers. A replacement AA that pays the wronged party is the planned fix.

## `/supported`

```json
{
  "x402Version": 2,
  "scheme": "batch-settlement",
  "network": "obyte:testnet",
  "extra": { "voucherManager": "facilitator", "minTimeout": 3600, "assets": ["base"] }
}
```

## Error codes

| Code                                                        | Meaning                                                |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `invalid_batch_settlement_obyte_payload`                    | malformed voucher                                      |
| `invalid_batch_settlement_obyte_voucher_signature`          | signature invalid or not by party B                    |
| `invalid_batch_settlement_obyte_channel_not_found`          | AA not defined on the ledger                           |
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
