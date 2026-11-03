# Security and trust

The formal decision is [ADR-0001](/adr/0001-trust-model). In plain words:

## Who can lose what

| You are                  | You trust                                                    | You can lose                                                                   | You protect yourself by                                                                                          |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Buyer**                | nobody for funds; the seller for delivering the service      | at most `--max` per call (and your channel deposit if you stop using it)       | spending limits (`--max`, `SpendingBudget`); never signing twice while a payment is pending (automatic)          |
| **Seller (exact)**       | the facilitator to verify honestly; the hub for ledger reads | the service, if you serve with `FINALITY=accepted` and the buyer double-spends | default `FINALITY=stable` for valuable responses                                                                 |
| **Seller (channels)**    | the facilitator with custody of the buyers' vouchers         | the channel balance, if a leaked voucher is used for a fraud proof (see below) | choosing a facilitator you trust; running your watcher; a channel window longer than your watcher can be offline |
| **Facilitator operator** | the hub                                                      | nothing of its own (non-custodial)                                             | API keys and rate limits on `/verify` and `/settle`                                                              |

## The channel risk, explained

The deployed channel AA pays a fraud proof to **whoever submits it**. A voucher
with a higher amount than the buyer declared in a close is a valid fraud proof.
So anyone holding the buyers' vouchers could, during a disputed close, take a
channel's balance.

What obbyx does about it:

- vouchers are stored **encrypted** in the facilitator database; the key is a
  separate file (`PACKAGE_KEY_FILE`, mode 0600);
- there is **no API** that returns stored vouchers; they go only to the
  seller's own watcher over its authenticated connection;
- every read of a stored voucher is journaled (`package_read` events);
- logs contain only fingerprints of vouchers and units;
- the facilitator code contains **no code that sends AA triggers**; a CI test
  enforces it. Only the seller's watcher closes, confirms and submits fraud
  proofs.

The fix is an AA version that pays the wronged party regardless of who submits
the proof; until then, channel payments mean trusting the facilitator.

## Seller duties (channels)

1. Keep the **watcher online**. When it is offline, channel payments are
   refused (buyers fall back to `exact`), but channels that buyers close
   meanwhile must be answered within the dispute window.
2. Keep **bytes** on the watcher address for triggers (`WATCHER_MIN_BYTES`,
   each trigger is sent with a 10 000-byte bounce fee).
3. Choose `minChannelTimeoutSeconds` longer than any outage you can have.
4. Protect the watcher database: it holds the vouchers that are your money.

## Keys and secrets

| Secret                               | Where                       | If leaked                                                                              |
| ------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------- |
| Wallet key (`wallet-<network>.json`) | `OBBYX_HOME`, mode 0600     | funds of that address                                                                  |
| `SELLER_SECRET`                      | seller                      | others can mint valid-looking offers for your routes (they still pay _you_); rotate it |
| `FACILITATOR_API_KEYS`               | facilitator and its sellers | others can use your facilitator                                                        |
| `PACKAGE_KEY_FILE`                   | facilitator                 | together with a database copy: the buyers' vouchers                                    |

See [operations](/guide/operations#rotating-keys) for rotation.

## Reporting a vulnerability

See `SECURITY.md` in the repository root: report privately, never in a public issue.
