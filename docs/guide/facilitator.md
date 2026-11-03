# Facilitator

`apps/facilitator` serves x402 `/verify`, `/settle` and `/supported` for Obyte.
All environment variables with defaults are in the
[configuration reference](/reference/configuration#facilitator-apps-facilitator);
every endpoint is in the [HTTP API reference](/reference/facilitator-api).

## Endpoints

| Endpoint            | Description                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `GET /supported`    | x402 v2 kinds (`exact` per configured network), `signers["obyte:*"]`                       |
| `POST /verify`      | Read-only verification of a payment                                                        |
| `POST /settle`      | Claims, broadcasts and tracks the payment; `settlement_pending` until final                |
| `GET /health`       | Liveness, networks, number of non-final settlements                                        |
| `GET /discovery/*`  | Bazaar catalog (see [x402 compatibility](./x402-compatibility.md))                         |
| `GET /openapi.json` | OpenAPI 3.1 of this API                                                                    |
| `WS /watcher`       | Sellers' watchers (signature login with the seller address; see [channels](./channels.md)) |

## Exposure

Only `/verify` and `/settle` need protection when the facilitator is reachable
from outside: set `FACILITATOR_API_KEYS` and give each seller's resource server
its key (`ObytePaywall` → `HTTPFacilitatorClient({ createAuthHeaders })`, demo:
`FACILITATOR_API_KEY`). `/supported`, `/health`, `/discovery/*` and `/openapi.json` are public and read-only; `/watcher` has its
own login. There is no dashboard or admin API.

## Stored channel vouchers

Client-signed vouchers are stored encrypted (AES-256-GCM) with the key in
`PACKAGE_KEY_FILE` (created on first start, mode 0600). They are sent only to
the seller's own watcher; each read is journaled as a `package_read` event.
See [security](./security.md) and [operations](./operations.md#package-key).

## Payment event journal

The `events` table records every `exact` state transition and, for channels,
`voucher_pending`, `voucher_committed`, `ack_timeout`, `voucher_refused` (with
the reason) and `watcher_connected` / `watcher_ack` / `watcher_disconnected`.
Inspect it with `pnpm --filter @obbyx/facilitator db:studio`.

## Error codes

All codes with causes and actions: [error reference](/reference/errors).
