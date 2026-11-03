# Introduction

obbyx lets any HTTP API charge for requests in GBYTE or Obyte assets using the
[x402](https://docs.x402.org) protocol (v2 and v1).

| Component         | Role                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Facilitator       | x402 `/verify`, `/settle`, `/supported`; verifies payments and broadcasts client-signed units |
| Seller middleware | Returns `402 Payment Required`, binds each payment to one operation                           |
| Seller watcher    | Stores channel commitments, closes channels, answers disputes                                 |
| Client SDK / CLI  | Pays for requests within configured budgets                                                   |

Two payment schemes:

- **exact** — one on-chain Obyte unit per request, signed by the client and
  broadcast by the facilitator.
- **batch-settlement** — off-chain cumulative commitments over Obyte AA payment
  channels, settled on-chain later by the seller's watcher.

> Status: under development. Read the [trust model](/adr/0001-trust-model)
> before using channels.
