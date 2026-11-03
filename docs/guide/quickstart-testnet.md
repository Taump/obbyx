# Quickstart on testnet

Run a facilitator, a paid demo API and pay for a request from the command
line — all on Obyte **testnet**. Requires Node 24.

```sh
npm i -g @obbyx/cli            # the obbyx command
git clone https://github.com/Taump/obbyx.git && cd obbyx
pnpm install && pnpm build     # the facilitator and the demo run from source
```

## 1. Wallets

The buyer needs testnet bytes; the seller only needs an address to be paid to.

```sh
# buyer wallet (~/.obbyx/wallet-testnet.json, mode 0600)
obbyx init
# seller address: a second wallet in another directory
OBBYX_HOME=~/.obbyx-seller obbyx init
```

Fund the **buyer** wallet from the testnet faucet (0.5–1 GBYTE, once per 24
hours per device) and wait until the bytes are stable:

```sh
obbyx faucet
obbyx balance
```

`obbyx faucet` talks to the "Faucet Bot" listed by the testnet hub over the
Obyte device protocol (encrypted chat): it pairs with the bot, sends your
address and prints the bot's replies. Its device key is stored next to the
wallet (`device-testnet.json`, mode 0600).

## 2. Facilitator

```sh
cd apps/facilitator
pnpm db:migrate            # creates ./data/facilitator.db (run again after upgrades)
LOG_PRETTY=1 node dist/main.js
# → http://127.0.0.1:4021  (GET /supported, /health; POST /verify, /settle)
```

See [facilitator configuration](./facilitator.md).

## 3. Demo seller API

```sh
cd apps/demo
PAY_TO=<seller address> SELLER_SECRET=$(openssl rand -hex 32) LOG_PRETTY=1 node dist/server.js
# → http://127.0.0.1:3402  GET /api/fortune (10000 bytes), POST /api/echo (20000 bytes)
```

## 4. Pay for a request

```sh
obbyx pay http://127.0.0.1:3402/api/fortune --max 0.00001
```

What happens:

1. The API answers `402` with an x402 v2 `PAYMENT-REQUIRED` offer bound to this
   request.
2. The CLI signs (but does not broadcast) a unit paying the seller, with the
   offer's binding in a data message, and repeats the request with
   `PAYMENT-SIGNATURE`.
3. The API asks the facilitator to settle; the facilitator broadcasts the unit
   and reports `settlement_pending` until it is stable (minutes under load, up
   to ~2 hours when the network has few transactions; for a quick demo run the
   facilitator with `FINALITY=accepted`). The CLI keeps retrying **with the
   same payment** for up to `--wait` seconds (default 600); if that is not
   enough it prints
   `--payment <header>` so you can resume later without paying again.
4. Once stable, the API runs the handler once and returns the result with a
   `PAYMENT-RESPONSE` header; the CLI prints the unit and an explorer link.

Repeating the same request with the same payment (`--payment <header>`)
returns the stored response without paying again; using it for a different
request is refused.

Watch the same flow step by step in the browser: [playground](./playground.md).

## By role

| You are                  | Next                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Seller**               | Put `ObytePaywall` (or the official `@x402/express` with `ObyteExactServer`) in front of your routes: [SDK](./sdk.md). For instant channel payments run a watcher: [payment channels](./channels.md). |
| **Buyer / agent**        | `payingFetch` with a budget ([SDK](./sdk.md)) or `obbyx pay` ([CLI reference](/reference/cli)); the official `@x402/fetch` works too ([x402 compatibility](./x402-compatibility.md)).                 |
| **Facilitator operator** | Docker Compose below, then [operations](./operations.md) and [security](./security.md).                                                                                                               |

### Facilitator with Docker Compose

```sh
docker compose up -d facilitator              # http://127.0.0.1:4021, data in a volume
curl http://127.0.0.1:4021/health
# sellers with channels: a watcher with the seller wallet from step 1
OBBYX_SELLER_HOME=~/.obbyx-seller docker compose --profile watcher up -d
```

Set `FACILITATOR_API_KEYS` in `docker-compose.yml` before exposing the
facilitator beyond localhost.
