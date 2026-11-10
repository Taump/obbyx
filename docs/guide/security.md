# Security and trust

The formal decision is [ADR-0001](/adr/0001-trust-model). In plain words:

## Who can lose what

| You are                  | You trust                                                    | You can lose                                                                   | You protect yourself by                                                                                 |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Buyer**                | nobody for funds; the seller for delivering the service      | at most `--max` per call (and your channel deposit if you stop using it)       | spending limits (`--max`, `SpendingBudget`); never signing twice while a payment is pending (automatic) |
| **Seller (exact)**       | the facilitator to verify honestly; the hub for ledger reads | the service, if you serve with `FINALITY=accepted` and the buyer double-spends | default `FINALITY=stable` for valuable responses                                                        |
| **Seller (channels)**    | your own watcher; the facilitator for honest verification    | unpaid service, if your watcher misses a close within the dispute window       | running your watcher; a channel window longer than your watcher can be offline                          |
| **Facilitator operator** | the hub                                                      | nothing of its own (non-custodial)                                             | API keys and rate limits on `/verify` and `/settle`                                                     |

## The channel risk, explained

Channels use the base AA **v1.2** (`7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR`;
deployed on testnet, not yet on mainnet). It pays
a fraud proof to **the wronged party** (the one that did not start the close),
whoever submits it. A leaked voucher therefore lets nobody take funds: a fraud
proof built from it can only pay the seller. You no longer trust the
facilitator for funds; what stays is **privacy**: a leaked voucher reveals who
paid whom and how much.

The earlier base AA v1.1 (`4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`) paid a fraud
proof to whoever submitted it, so anyone holding vouchers could take a
channel's balance during a disputed close. Channels on v1.1 are no longer paid
into: the facilitator refuses their vouchers and offers name only v1.2. They
can still be closed and defended.

A voucher is accepted only in the exact shape the channel AA accepts on-chain
(no `timestamp`, no `last_ball_unit`, version 2.0–4.0): one the AA would reject
could never be used in a close or a fraud proof. A buyer's retry of a stored
voucher is refused only definitely: its channel moved to a later period, or it
fails the current rules (e.g. a raised minimum dispute window). Such a voucher
is cancelled at once, so it frees the channel and never reaches the seller's
watcher. While the outcome is unknown (hub unreachable or lagging) it stays
`settlement_pending`. The exact rules are in the
[scheme spec](/specs/scheme_batch_settlement_obyte).

What obbyx does to keep vouchers private:

- vouchers are stored **encrypted** in the facilitator database; the key is a
  separate file (`PACKAGE_KEY_FILE`, mode 0600);
- there is **no API** that returns stored vouchers; they go only to the
  seller's own watcher over its authenticated connection;
- every read of a stored voucher is journaled (`package_read` events);
- logs contain only fingerprints of vouchers and units;
- the facilitator code contains **no code that sends AA triggers**; a CI test
  enforces it. Only the seller's watcher closes, confirms and submits fraud
  proofs.

### Where to keep `PACKAGE_KEY_FILE`

Keep the key outside the database directory and its backups, e.g.
`PACKAGE_KEY_FILE=/etc/obbyx/package.key`. The default `./data/package.key`
sits next to the database and is kept only for existing deployments. The
facilitator:

- logs a **warning** when the key file is inside the database's directory;
- with `NODE_ENV=production`, **refuses to start** unless `PACKAGE_KEY_FILE` is
  set explicitly;
- creates a key file **only for an empty database**; with stored vouchers it
  refuses to start when the key file is missing or decrypts none of the newest
  vouchers, instead of generating a new key.

To move a key: stop the facilitator, move the file (keep mode 0600), set
`PACKAGE_KEY_FILE` and start again.

#### Docker Compose

The shipped `docker-compose.yml` mounts the key as a read-only secret,
`/run/secrets/package.key`, from a host file outside the data volume
(`~/.obbyx-facilitator/package.key`, or the path in `OBBYX_FACILITATOR_KEY`).
Create it before the first start:

```bash
mkdir -p ~/.obbyx-facilitator
(umask 077; openssl rand -base64 32 > ~/.obbyx-facilitator/package.key)
# Linux: the container runs as uid 1000
sudo chown 1000:1000 ~/.obbyx-facilitator/package.key
```

A deployment started with an older `docker-compose.yml` has its key at
`/data/package.key`, **inside** the data volume. Move it out before switching
to the new file (do not create a new key: startup would refuse it):

```bash
docker compose stop facilitator                    # still the old compose file
mkdir -p ~/.obbyx-facilitator
docker compose cp facilitator:/data/package.key ~/.obbyx-facilitator/package.key
chmod 600 ~/.obbyx-facilitator/package.key         # Linux: also chown 1000:1000
# switch to the new docker-compose.yml, then:
docker compose up -d facilitator                   # checks the key against the stored vouchers
docker compose exec facilitator rm /data/package.key   # once it started cleanly
```

Keep a backup of the key file apart from the database backups.

### Upgrading with pending vouchers

A voucher a previous version already **committed** is still answered with
success on a retry. One still **pending** is checked again under the new rules
(package profile, v1.2 channel); if it fails them it is refused and cancelled
(the seller never receives it). Drain pending vouchers
before upgrading: keep the watcher connected until this returns 0, then stop
and upgrade:

```bash
sqlite3 data/facilitator.db "SELECT count(*) FROM batch_commitments WHERE state = 'pending'"
```

## Seller duties (channels)

Accept channel payments through **one facilitator and one watcher** per seller
address (the channel's cumulative amount is tracked there).

1. Keep the **watcher online**. When it is offline, channel payments are
   refused (buyers fall back to `exact`), but channels that buyers close
   meanwhile must be answered within the dispute window.
2. Keep **bytes** on the watcher address for triggers (`WATCHER_MIN_BYTES`,
   each trigger is sent with a 10 000-byte bounce fee).
3. Choose `minChannelTimeoutSeconds` longer than any outage you can have. The
   watcher reacts to a close only once it is stable (1–2 h lag), so the
   facilitator refuses `MIN_CHANNEL_TIMEOUT_SECONDS` below 3600 (default 4 h).
4. Protect the watcher database: it holds the vouchers that are your money.

## Keys and secrets

| Secret                               | Where                       | If leaked                                                                              |
| ------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------- |
| Wallet key (`wallet-<network>.json`) | `OBBYX_HOME`, mode 0600     | funds of that address                                                                  |
| `SELLER_SECRET`                      | seller                      | others can mint valid-looking offers for your routes (they still pay _you_); rotate it |
| `FACILITATOR_API_KEYS`               | facilitator and its sellers | others can use your facilitator                                                        |
| `PACKAGE_KEY_FILE`                   | facilitator                 | together with a database copy: the buyers' vouchers (privacy only, not funds)          |

See [operations](/guide/operations#rotating-keys) for rotation.

## Reporting a vulnerability

See `SECURITY.md` in the repository root: report privately, never in a public issue.
