# Concepts

## x402 in one picture

```text
 client                     seller API                    facilitator              Obyte
   │  GET /api/x               │                               │                      │
   │──────────────────────────▶│                               │                      │
   │  402 + PAYMENT-REQUIRED   │  (offer: scheme, amount,      │                      │
   │◀──────────────────────────│   payTo, binding, validUntil) │                      │
   │  sign payment             │                               │                      │
   │  GET /api/x + PAYMENT-SIGNATURE                           │                      │
   │──────────────────────────▶│  POST /verify ───────────────▶│  read inputs, ball  │
   │                           │◀─────────────── isValid ──────│◀────────────────────│
   │                           │  POST /settle ───────────────▶│  broadcast / commit │
   │                           │◀── success | settlement_pending──────────────────────│
   │  200 + PAYMENT-RESPONSE   │                               │                      │
   │◀──────────────────────────│                               │                      │
```

The seller never sees the client's keys; the facilitator never holds funds.

## Two schemes

|             | `exact`                                                                                 | `batch-settlement`                                       |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Per request | one Obyte unit, signed by the client, broadcast by the facilitator                      | one signed voucher, nothing on-chain                     |
| Speed       | waits for finality (minutes under load, up to ~2 h with few transactions) or `accepted` | instant (watcher ack)                                    |
| Fees        | network fee per request (paid by the client)                                            | one deposit unit, one close                              |
| Needs       | nothing                                                                                 | an open channel; the seller runs a watcher               |
| Spec        | [exact](/specs/scheme_exact_obyte)                                                      | [batch-settlement](/specs/scheme_batch_settlement_obyte) |

`payingFetch` and `obbyx pay` use a channel when one is open to the seller and
fall back to `exact` otherwise.

## One payment, one operation

Every offer carries a **binding**: an HMAC of the seller over the request
(method, URL, body), the price and the quote. The client signs it into the
payment, so a payment for one request cannot pay for another, and the seller
records each payment proof so it serves one operation only. A repeated request
with the same proof returns the stored response (`ObytePaywall`) instead of
charging again.

## Lifecycle of an `exact` payment

```text
claimed ──▶ broadcasting ──▶ accepted ──▶ stable_good   (success with FINALITY=stable)
   │              │              └──────▶ final_bad     (double spend)
   │              └──▶ rejected                           (hub refused, unit unknown)
   └──▶ expired                                           (never published in the window)
```

Until success the facilitator answers `settlement_pending` with the unit hash.
Retrying the same request is always safe.

## Time windows

| Window                                      | Set by                                    | Meaning                                                    |
| ------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Offer validity (`validUntil`)               | seller (`quoteTtlSeconds`, default 300 s) | after it, pay again with a new offer                       |
| Proof acceptance (`maxTimeoutSeconds`)      | seller                                    | the unit timestamp must be recent                          |
| Last ball age (`MAX_LAST_BALL_AGE_SECONDS`) | facilitator (default 3 h)                 | how far behind the network's stable point may be           |
| Publication window                          | facilitator (`PUBLISH_WINDOW_SECONDS`)    | a verified unit is never broadcast later                   |
| Client wait (`--wait`, `pendingTimeoutMs`)  | client                                    | how long to wait for finality before returning "pending"   |
| Channel dispute window (`--window`)         | client, ≥ seller `minTimeout`             | how long the seller has to answer a client-initiated close |

## Finality

- `FINALITY=stable` (default): success only when the unit is stable and good,
  proven by a proof chain from the hub.
- `FINALITY=accepted`: success when the network accepted the unit. Faster, but
  the seller serves before finality; a double spend is detected afterwards.

How fast units become stable depends on traffic: minutes under load, up to
about 2 hours when the network has few transactions. That is normal, not an
outage; clients keep retrying the same payment and never pay twice.

## Components

| Component         | Where                                                    | Runs by                   |
| ----------------- | -------------------------------------------------------- | ------------------------- |
| Facilitator       | `apps/facilitator`                                       | anyone (the operator)     |
| Seller middleware | `@obbyx/sdk` (`ObytePaywall`, `Obyte*Server`)            | the seller                |
| Seller watcher    | `apps/watcher`                                           | the seller (for channels) |
| Client            | `@obbyx/sdk` (`payingFetch`), `obbyx` CLI, `@x402/fetch` | the buyer / agent         |
