# Scheme: `exact` on Obyte

## Summary

The client composes and signs a complete Obyte **unit** that pays the seller
and does **not** broadcast it. The facilitator verifies the unit against the
payment requirements and broadcasts it in `/settle`. Funds move from the payer
directly to `payTo`; the facilitator never holds them and signs nothing.

Asset transfer method family: **facilitator-submitted, payer-signed**.

| Property             | Value                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fee payer            | the payer (fees are inside the signed unit)                                                                      |
| Replay primitive     | exclusive: the unit spends specific outputs; a second unit spending them is non-serial (final-bad)               |
| Validity window      | `extra.validUntil` (offer) + the facilitator's publication window; the last ball at most `MAX_LAST_BALL_AGE` old |
| Duplicate submission | the same unit hash; settlement is deduplicated atomically on `(network, unit hash)`                              |
| Payment flow         | `upfront` (settle before serving)                                                                                |

## Network Identifiers

| Network       | CAIP-2 (v2)     | v1 name         |
| ------------- | --------------- | --------------- |
| Obyte mainnet | `obyte:livenet` | `obyte-livenet` |
| Obyte testnet | `obyte:testnet` | `obyte-testnet` |

The `obyte` CAIP-2 namespace is not registered with ChainAgnostic; the
references `livenet` and `testnet` are the network names used by Obyte nodes.
Facilitators advertise the family `obyte:*` in `/supported.signers`.

## `PaymentRequirements`

| Field               | Rule                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `scheme`            | MUST be `exact`                                                                                      |
| `network`           | MUST be `obyte:livenet` or `obyte:testnet`                                                           |
| `asset`             | `base` (bytes) or the 44-character id of a public divisible asset allowed by the facilitator         |
| `amount`            | integer string in the smallest units, > 0                                                            |
| `payTo`             | the seller's Obyte address (32 characters); MUST NOT be an autonomous agent                          |
| `maxTimeoutSeconds` | the unit's timestamp MUST be within this many seconds (+ clock tolerance) of the facilitator's clock |
| `extra.binding`     | 64 lowercase hex characters: the seller's binding of this offer to one request (below)               |
| `extra.quoteId`     | 8–64 characters `[A-Za-z0-9_-]`, random per offer                                                    |
| `extra.validUntil`  | unix seconds; the facilitator MUST refuse the payment after it                                       |
| `extra.paymentFlow` | `"upfront"` when present; `"escrow"` MUST be rejected                                                |

`extra` MUST NOT contain other keys. In particular a non-empty `extra.splits`
(multi-payee) and any `extra.assetTransferMethod` MUST be rejected: there is no
asset transfer method on Obyte, the payer signs the transfer itself.

```json
{
  "scheme": "exact",
  "network": "obyte:testnet",
  "asset": "base",
  "amount": "20000",
  "payTo": "AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6",
  "maxTimeoutSeconds": 300,
  "extra": {
    "binding": "8250cd430d380360c4ec0aa6b574e319c2992cb27b62c8d1755fe230261b40a0",
    "quoteId": "hCqM06Z6HeK59fTBQm5rFg",
    "validUntil": 1793733110,
    "paymentFlow": "upfront"
  }
}
```

### Binding

```text
binding = HMAC-SHA256(sellerSecret, canonical({v: 1, sellerId, scheme, quoteId,
          validUntil, method, url, bodyHash, network, asset, amount, payTo}))
```

`canonical` is JSON with object keys sorted; `method` is upper-case; `url` is
the path and query string; `bodyHash` is the SHA-256 hex of the canonical
request body (of the empty string when there is none). Only the seller can
compute it. On the paid request the seller recomputes it from the request and
MUST refuse a payment whose binding differs: one payment pays for one
operation only.

Test vector: secret `"ssssssssssssssssssssssssssssssss"` (32 × `s`), sellerId
`api`, scheme `exact`, quoteId `quote-0001`, validUntil `1790000310`, method
`GET`, url `/api/x`, empty body, network `obyte:testnet`, asset `base`, amount
`20000`, payTo `AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6` →
`d0a417add6f72db9139e06a23107f8d7494d7b6f92d81edd0d949ec30a7ad698`.

## `PaymentPayload.payload`

```json
{
  "unit": { "version": "4.0t", "alt": "2", "unit": "<44-char hash>", "authors": [], "messages": [] }
}
```

The unit MUST match this profile:

1. exactly one author, with a single-signature definition `["sig", {"pubkey": …}]`; the definition MUST be included if the address is not yet known on the ledger;
2. `version`/`alt` of the requested network;
3. inline payloads only; one `payment` message per asset; a bytes payment is always present (fees);
4. exactly one output of `amount` to `payTo` in `asset`;
5. exactly one `data` message `{"x402": {"binding": <extra.binding>, "quoteId": <extra.quoteId>}}`;
6. no other message types; the serialized unit at most 16 KiB;
7. the payer MUST be neither `payTo` nor an address of the facilitator operator;
8. `payTo` MUST NOT be an autonomous agent (checked against the ledger): a payment to an AA triggers it, and the AA may bounce the funds back to the payer.

## Verification

`/verify` is read-only: nothing is stored or broadcast. The facilitator MUST check:

1. requirements well-formed; `accepted` equals the requirements;
2. the offer is alive (`extra.validUntil`);
3. locally: structure and profile, unit hash, payload hashes, author definition and signature, commissions consistent with the unit size;
4. payment terms: recipient, amount, asset, binding and quoteId;
5. freshness: unit timestamp within `maxTimeoutSeconds` (+ clock tolerance); `last_ball` not older than `MAX_LAST_BALL_AGE` (default 3 h — with few transactions the stable point normally lags up to ~2 h; the payment cannot predate its offer, whose random `quoteId` it carries);
6. against the ledger: every input exists, belongs to the payer, is in the right asset and is not spent by another unit; inputs balance outputs plus fees.

## Settlement

`/settle` is idempotent; the key is `(network, unit hash)`.

```text
claimed → broadcasting → accepted → stable_good   (success)
                                  → final_bad     (double spend)
        → rejected   (the hub refused the unit and it is unknown)
        → expired    (never published within the publication window)
```

- The facilitator MUST NOT broadcast after the publication window.
- A hub answer that is not final ("already handling this unit", "known unverified", "unknown parents", "need hash tree") MUST NOT be treated as a rejection.
- Until finality the answer is `settlement_pending` with `transaction` = the unit hash. The caller repeats the same request; it is never charged twice.
- An internal error after the claim MUST be reported as `settlement_pending`, never as a failure.
- `stable` finality: success when the unit's ball is in a proof chain and not non-serial. `accepted` finality: once the network accepted the unit (the seller bears the double-spend risk until stable).

```json
{
  "success": true,
  "transaction": "sCwymhBKqhMg1X6GCfkQnyMmjsYxYhjLhP7DRVG9skE=",
  "network": "obyte:testnet",
  "payer": "IJMD4SMQGTFGSIK4LFV2E3KG7RD6SZ3C",
  "amount": "10000"
}
```

`invalidMessage` / `errorMessage` are diagnostics only; clients act on the reason codes.

## `/supported`

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "obyte:testnet",
  "extra": { "finality": "stable", "assets": ["base"] }
}
```

## Error codes

| Code                                                                            | Meaning                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `invalid_exact_obyte_unsupported_unit`                                          | unit outside the profile                                   |
| `invalid_exact_obyte_unit_too_large`                                            | serialized unit above the limit                            |
| `invalid_exact_obyte_network`                                                   | version/alt of another network                             |
| `invalid_exact_obyte_unit_hash`, `invalid_exact_obyte_payload_hash`             | hashes do not match the content                            |
| `invalid_exact_obyte_definition`, `invalid_exact_obyte_definition_required`     | definition missing or not matching the author              |
| `invalid_exact_obyte_signature`                                                 | invalid author signature                                   |
| `invalid_exact_obyte_commissions`                                               | commissions do not match the unit size                     |
| `invalid_exact_obyte_recipient_mismatch`, `_amount_mismatch`, `_asset_mismatch` | payment terms differ                                       |
| `invalid_exact_obyte_binding_mismatch`                                          | bound to another request or offer                          |
| `invalid_exact_obyte_payer`                                                     | payer is payTo or a facilitator address                    |
| `invalid_exact_obyte_payto_is_aa`                                               | payTo is an autonomous agent (it could bounce the payment) |
| `invalid_exact_obyte_inputs`                                                    | inputs missing, foreign, unbalanced or spent               |
| `invalid_exact_obyte_stale`                                                     | unit timestamp or last ball too old                        |
| `invalid_exact_obyte_quote_expired`                                             | the offer expired                                          |
| `invalid_exact_obyte_publication_window_expired`                                | never published in time                                    |
| `invalid_exact_obyte_rejected_by_network`                                       | the hub refused the unit                                   |
| `invalid_exact_obyte_double_spend`                                              | the unit became final-bad                                  |
| `invalid_exact_obyte_ledger_unavailable`                                        | the hub did not answer (outcome unknown; retry)            |
| `invalid_exact_obyte_payment_reused`                                            | facilitator: this unit is already bound to another binding |
| `invalid_exact_obyte_payment_already_used`                                      | resource server: the payment already served a request     |
| `invalid_exact_obyte_payment_in_progress`                                       | resource server: another request is serving this payment  |

## Security considerations

- **Replay.** A unit settles once: the dedup key is the unit hash, which does not cover the signatures, so a signature cannot be re-encoded into a new key. Spent inputs make any second unit final-bad.
- **Authorization scope.** The binding ties the payment to one method, URL, body, price and payee; the seller refuses it for any other request.
- **Settlement atomicity.** The claim is a compare-and-set; concurrent `/settle` calls for one unit broadcast at most once.
- **Leaked unit.** A signed but unpublished unit can be published by anyone and then pays the seller the signed amount without service. Clients treat a signed payment as spent until it is rejected or expired and do not reuse its inputs meanwhile.
- **Ledger trust.** Inputs, the last ball and stability come from the hub (light vendor); hashes, signatures and the profile are verified locally.
