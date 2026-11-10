# Operations (runbooks)

How to run the facilitator and a seller watcher, what to watch, and what to do
when something goes wrong. Configuration: [reference](/reference/configuration).

## Running

```sh
pnpm install && pnpm build
pnpm --filter @obbyx/facilitator db:migrate      # every upgrade, before start
node apps/facilitator/dist/main.js               # one process per DB_PATH
```

or with Docker Compose (facilitator + optional watcher):

```sh
# once: the package key, outside the data volume (see Package key below)
mkdir -p ~/.obbyx-facilitator && (umask 077; openssl rand -base64 32 > ~/.obbyx-facilitator/package.key)
docker compose up -d facilitator
docker compose --profile watcher up -d           # sellers with channels
```

The images are not built in CI. Before a release, check them by hand:
`docker build -t obbyx-facilitator .`, `docker build --build-arg APP=watcher -t obbyx-watcher .`,
then `docker run -e HOST=0.0.0.0 -p 127.0.0.1:4021:4021 obbyx-facilitator` and `curl /health`.

Only one facilitator may use a database file: a second one exits with
"Database … is in use by another facilitator process". Restarts are safe: pending `exact`
settlements are resumed by the recovery worker, and watchers replay their
journal from their cursor.

## What to watch

| Signal                                                     | Where                             | Meaning                                  | Action                                                                  |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `activeSettlements` keeps growing                          | `GET /health`                     | units not becoming final                 | [Stuck pending](#stuck-pending-payments)                                |
| bursts of `invalid_exact_obyte_stale`                      | facilitator log (`settle result`) | the network's stable point lags          | [Slow stabilization](#slow-stabilization)                               |
| `*_ledger_unavailable`, `hub_unavailable` events           | log / `events`                    | hub does not answer                      | check `HUB_URL_*`; outcomes stay pending, nothing is lost               |
| `watcher_disconnected` without a later `watcher_connected` | `events`                          | a seller watcher is offline              | [Watcher offline](#watcher-offline-or-behind)                           |
| `ack_timeout` events                                       | `events`                          | watcher slow to store vouchers           | [Watcher offline](#watcher-offline-or-behind)                           |
| `voucher_refused` with a reason                            | `events`                          | the watcher rejected a voucher           | expected for invalid vouchers; many from one buyer = misbehaving client |
| `package_corrupt` errors                                   | log                               | wrong `PACKAGE_KEY_FILE`                 | [Package key](#package-key)                                             |
| `request refused` warnings with `rate_limited`             | log                               | a client exceeds `RATE_LIMIT_PER_MINUTE` | raise the limit for that key or block it                                |

Every line of one payment carries the same `binding` and `proofId`; use
`obbyx logs <files> --binding <b>` to see it across seller, facilitator and
watcher.

## Stuck pending payments

An `exact` settlement stays `settlement_pending` until its unit is final.

1. Find it: `obbyx logs facilitator.log --proof <unit hash>` or the `events`
   table (`key` = `<network>:<unit>`).
2. Look the unit up in the explorer (testnet:
   `https://testnetexplorer.obyte.org/<unit>`).
   - **Not on the ledger** and the publication window has passed → it becomes
     `expired` automatically; the buyer pays again.
   - **On the ledger, not stable** → wait; the recovery worker checks every
     `RECOVERY_INTERVAL_MS`. Stability can take minutes on testnet.
   - **Stable but still pending** → the hub's proof chain lags its stable
     point (normal for a few minutes, see ADR-0002). With few transactions
     stabilization itself can take up to ~2 hours; that is normal. If it persists, check the
     hub or switch `HUB_URL_*`.
3. Never re-send the unit by hand while its state is `broadcasting` or
   `accepted`; the facilitator is idempotent and resumes by itself.

Buyers retry with the same payment (`obbyx pay … --payment <header>`); they
are never charged twice.

## Slow stabilization

A payment unit references the network's last stable ball. If that ball is
older than `MAX_LAST_BALL_AGE_SECONDS` (default 10800 s = 3 h), new `exact` payments
are refused with `invalid_exact_obyte_stale` ("Last ball is N s old; the limit
is M s"). Nothing is broadcast and nobody pays. With few transactions a lag
of up to ~2 hours is normal; the default leaves a margin above it.

- Wait until the network catches up, or raise `MAX_LAST_BALL_AGE_SECONDS`
  (up to 86400). Raising it is safe for freshness — a payment is bound to a
  recent offer — but with `FINALITY=stable` the payments will also take long
  to become final while the lag lasts.
- Channel payments (`batch-settlement`) keep working: they do not use the
  last ball.

## Watcher offline or behind

Channel payments need the seller's watcher online and funded. While it is
offline, `/verify` refuses channel payments (`…_watcher_unavailable`) and
buyers fall back to `exact` — no voucher is accepted that the seller cannot
store.

1. Check the watcher process and its log (`watcher.main` connects, then
   `bootstrap` re-subscribes on every hub reconnect).
2. Check its bytes: `OBBYX_HOME=<seller home> obbyx balance`; top up above
   `WATCHER_MIN_BYTES`.
3. After a restart it sends its cursor and receives every voucher it missed;
   `voucher_committed` events follow for the pending ones.
4. Channels that buyers closed while the watcher was offline: the watcher
   answers on reconnect if the dispute window is still open. That is why
   `minChannelTimeoutSeconds` must exceed any outage you can have.

## Rotating keys

| Key                     | How                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACILITATOR_API_KEYS`  | Add the new key next to the old one (comma-separated), move sellers to it (`FACILITATOR_API_KEY`), restart, then remove the old key.                                       |
| `SELLER_SECRET`         | Restart the seller with the new secret during low traffic. Open offers become invalid: buyers get a fresh 402 and pay the new offer; payments already made are unaffected. |
| Seller wallet (watcher) | Close the channels of the old address first (`close` / `confirm` by the watcher), then switch `payTo` and `OBBYX_HOME` to the new wallet.                                  |
| Buyer wallet            | Close your channels (`obbyx channel close`, `confirm`), move funds, `obbyx init --force` in a new `OBBYX_HOME`.                                                            |

### Package key

`PACKAGE_KEY_FILE` encrypts stored channel vouchers. Where to keep it, the
startup checks and moving it out of the Docker data volume are described in
[security](./security.md#where-to-keep-package-key-file). Docker Compose mounts
it read-only as a secret from `~/.obbyx-facilitator/package.key` (override with
`OBBYX_FACILITATOR_KEY`). The key cannot be rotated in place: replace it only
after all watchers have acknowledged every voucher (no `pending` rows in
`batch_commitments`).

## Moving to mainnet

1. Test the full flow on testnet: `exact` with `FINALITY=stable`, a channel
   open → pay → close, a watcher restart, a facilitator restart while a
   payment is pending.
2. Set `NETWORKS=obyte:livenet` (or both), `ASSETS_LIVENET`, and a livenet
   hub if you do not use the public one.
   Channels (`batch-settlement`) need the base AA v1.2 deployed on mainnet
   first: until then the facilitator does not offer or accept them on
   `obyte:livenet` (it logs why at startup), and only `exact` works there.
3. Set `FACILITATOR_API_KEYS`, put the facilitator behind TLS, keep
   `HOST=127.0.0.1` behind the proxy.
4. Create **new** wallets for livenet (`obbyx init --network livenet`); fund
   the watcher address.
5. Keep `FINALITY=stable` unless a route's value is lower than the risk of a
   double spend.
6. Keep `PACKAGE_KEY_FILE` outside any copy of the database you share.
