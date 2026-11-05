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

## Roles

Four parties take part in a payment; two more are outside our control (the
Obyte network and, for channels, the channel autonomous agent).

| Role                 | Where                                                    | Runs by                   | Holds                                    |
| -------------------- | -------------------------------------------------------- | ------------------------- | ---------------------------------------- |
| Client (buyer)       | `@obbyx/sdk` (`payingFetch`), `obbyx` CLI, `@x402/fetch` | the buyer / agent         | the buyer's key, its coins and channels  |
| Seller API (paywall) | `@obbyx/sdk` (`ObytePaywall`, `Obyte*Server`)            | the seller                | the binding secret (HMAC), no funds key  |
| Facilitator          | `apps/facilitator`                                       | the seller or an operator | no keys; settlement and voucher journals |
| Seller watcher       | `apps/watcher`                                           | the seller (for channels) | the seller's key; every voucher received |

- **Client.** Pays for a request: reads the seller's offer, signs a payment
  (an Obyte unit for `exact`, a voucher for a channel) and retries the same
  payment until it is final. It never broadcasts and never talks to the
  facilitator; it only enforces its own limits (price cap, budget, fee cap).
- **Seller API (paywall).** Sells the resource: issues offers bound to one
  request (binding), checks that a payment matches that request, asks the
  facilitator to verify and settle it, and serves each payment at most once.
- **Facilitator.** Checks and settles payments for sellers. For `exact` it
  validates the client's unit against the ledger and broadcasts it; for
  channels it checks the voucher and keeps it in a journal until the seller's
  watcher confirms it. It signs nothing and holds no funds.
- **Seller watcher.** Protects the seller's channel earnings: stores every
  voucher durably before it is reported paid (signed ack), refuses invalid
  ones (signed nack), and closes channels or answers a dishonest close with a
  fraud proof. Only needed for channel payments.
- **Obyte network and channel AA** (external). The ledger that decides
  finality and double spends; the base autonomous agent that holds channel
  deposits and pays out on close.

### Are they independent?

As processes, yes: each runs separately with its own key (or none) and its
own database, and they talk only through defined interfaces:

- client ↔ seller API: x402 over HTTP (`PAYMENT-REQUIRED`,
  `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`);
- seller API → facilitator: `POST /verify`, `POST /settle` (optional API key);
- watcher → facilitator: an outbound WebSocket at `/watcher`, with a signed
  login and signed ack/nack receipts;
- everyone ↔ an Obyte hub for ledger reads.

Functionally they depend on each other in these ways:

- `exact` needs only the client, the seller API and a facilitator.
- Channel payments also need the seller's watcher online; without it they
  are refused (fail-closed) and clients fall back to `exact`.
- The watcher and its facilitator are the tightest pair: they share the
  voucher journal and the protocol version, so upgrade them together
  (facilitator first). Use one facilitator per seller address for channels.
- The facilitator can be run by the seller itself or by a third party; it
  never holds anyone's key, so even a compromised facilitator cannot sign a
  payment.
