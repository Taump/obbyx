# Payment channel AA (base AA v1.2)

`channels_base_aa_1.2.oscript` is the base autonomous agent obbyx uses for
payment channels. It is the base AA of
[aa-channels-lib](https://github.com/Papabyte/aa-channels-lib) (v1.1),
rewritten in modern Oscript, with one fix: **a fraud proof pays the wronged
party** (the one that did not start the close) instead of `trigger.address`.

| Version | File                                             | Address                            | Status                                                                   |
| ------- | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------ |
| **1.2** | `channels_base_aa_1.2.oscript`                   | `7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR` | used by obbyx (`CHANNEL_BASE_AA`); deployed on testnet; mainnet: not yet |
| 1.1     | `channels_base_aa_1.1.oscript` (Oscript rewrite) | `5KHQT6E6SUVD35D7NVXWEKZNNNHG7ZVM` | testnet only, reference for the diff                                     |
| 1.1     | original `.ojson` (git history, on-chain)        | `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` | retired: `LEGACY_CHANNEL_BASE_AAS`, existing channels can only be closed |

Diffs: `channels_base_aa_1.1.ojson-to-oscript.diff` (deployed `.ojson` →
Oscript, same logic) and `channels_base_aa_1.1-to-1.2.diff` (the fix).
The AA address is the chash of the definition, so every change of the text
changes the address; `test/test_base_aa_address.oscript.js` checks that the
constant in `packages/obyte/src/channel/definition.ts` is the address of the
1.2 file.

### Why 1.2

In 1.1 the fraud-proof case pays everything to whoever submits it and does not
check the sender. In obbyx only the client signs vouchers, so:

- a stranger holding a leaked client voucher could take a channel during a
  dishonest client close;
- worse, **the client itself** could close declaring 0 and immediately submit
  its own voucher as a fraud proof (from its own or a second address) to get
  the whole balance back, before the seller's watcher reacts.

In 1.2 the proof can still come from anyone, but the money always goes to the
wronged party, so neither attack pays. `test/test_fraud_proof_payout.oscript.js`
runs both attacks against 1.1 (they succeed) and 1.2 (the seller is paid).

obbyx never deploys this file. Every channel is a **parameterized AA** that
references the deployed base AA; the file is kept here for reading, reviewing
and testing the channel logic.

- How obbyx uses channels: [docs/guide/channels.md](../docs/guide/channels.md)
- Design and binding: [ADR-0003](../docs/adr/0003-batch-settlement-binding-and-watcher.md)
- Trust model and risks: [ADR-0001](../docs/adr/0001-trust-model.md)
- Address derivation / definition parsing: [packages/obyte/src/channel/definition.ts](../packages/obyte/src/channel/definition.ts)

## Contents

| Path                                         | What it is                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `channels_base_aa_1.2.oscript`               | The base AA used by obbyx.                                                                                 |
| `channels_base_aa_1.1.oscript`               | v1.1 in modern Oscript (reference).                                                                        |
| `channels_base_aa_1.1-to-1.2.diff`           | The 1.2 fix.                                                                                               |
| `channels_base_aa_1.1.ojson-to-oscript.diff` | Diff from the deployed `.ojson` to the `.oscript`.                                                         |
| `test/test_with_bytes.oscript.js`            | Original scenarios for a channel in bytes (`asset: 'base'`), run on 1.1 and 1.2.                           |
| `test/test_with_assets.oscript.js`           | The same scenarios for a channel in a custom asset, run on 1.1 and 1.2.                                    |
| `test/test_fraud_proof_payout.oscript.js`    | Who receives a fraud proof: attacks on 1.1, the fix in 1.2.                                                |
| `test/test_base_aa_address.oscript.js`       | `CHANNEL_BASE_AA` equals the address of the 1.2 file.                                                      |
| `test/test_obbyx_binding.oscript.js`         | obbyx: `binding`/`payment_amount` in signed packages, tampering, a stranger's fraud proof pays the seller. |
| `test/test_obbyx_watcher_actions.oscript.js` | obbyx: exact `close`/`confirm`/`fraud_proof` triggers of the watcher and the CLI.                          |
| `test/bootload.js`, `test/mocha.opts`        | mocha bootstrap: global `expect`, `errMsg` and chai helpers from aa-testkit.                               |
| `package.json`                               | Isolated test package (mocha, chai, aa-testkit).                                                           |

## Running the tests

The folder is deliberately **not** part of the pnpm workspace
(`pnpm-workspace.yaml` includes only `packages/*` and `apps/*`):

- the tests are CommonJS, while the root `package.json` has `"type": "module"`;
  the local `package.json` (no `type`) keeps `.js` files as CommonJS;
- aa-testkit pulls ocore from git with native sqlite builds, which the root
  install policy (`allowBuilds`, `minimumReleaseAge`) does not allow and which
  nothing else in the repo needs.

```sh
cd aa
npm install
npm test        # mocha --require test/bootload.js
```

aa-testkit starts a local Obyte network (genesis node, witness, hub, wallets,
explorer) in child processes; each suite takes up to a couple of minutes.

The obbyx-specific checks (formerly `spikes/aa-channel-binding`) run in the
same suite: `test/test_obbyx_binding.oscript.js` (extra fields in the signed
package, a stranger's fraud proof) and `test/test_obbyx_watcher_actions.oscript.js`
(the exact triggers of the seller watcher and the buyer CLI).

---

## How the AA works

### Model

A channel is a two-party escrow between **A** and **B** for one asset. Both
parties deposit funds into the AA; off-chain they exchange **signed packages**
("vouchers") that state the cumulative amount the signer has spent to the
other party in the current period. Nothing goes on-chain per payment. To get
the money out, one party starts a close declaring the amounts, the other party
confirms (or the dispute window expires), and the AA pays out the final
balances. If the closing party understated what it spent, a **fraud proof**
(the initiator's own higher voucher) gives everything to the other party.

After a close the channel is not destroyed: `period` is incremented and the
same AA address can be funded and used again.

In obbyx the channel is used one-way: **A = seller** (payee, x402 `payTo`),
**B = client** (payer). Only B deposits, only B signs vouchers.

### Parameters

A channel AA is defined as

```json
[
  "autonomous agent",
  {
    "base_aa": "7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR",
    "params": { "addressA": "…", "addressB": "…", "asset": "base", "salt": "…", "timeout": 86400 }
  }
]
```

| Param                  | Meaning                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `addressA`, `addressB` | The two parties. Only triggers from these addresses can deposit, close or confirm.                  |
| `asset`                | `'base'` for bytes, otherwise a 44-char asset id. One channel = one asset.                          |
| `timeout`              | Dispute window in **seconds** (compared with `timestamp`).                                          |
| `salt`                 | Optional, not read by the AA. Only changes the address, so the same pair can have several channels. |

The channel address is the chash of this definition, so it is fully determined
by the parameters. obbyx recomputes it from the on-chain definition instead of
trusting parameters from a voucher (`parseChannelDefinition`).

### State variables

| Var                    | Meaning                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `period`               | Current period, starts at `1` on the first accepted deposit, `+1` after each close. Vouchers are valid only for the current period. |
| `balanceA`, `balanceB` | Total deposited by each party in this period.                                                                                       |
| `close_initiated_by`   | `'A'` / `'B'` while a close is pending, otherwise unset.                                                                            |
| `close_start_ts`       | Timestamp of the close request.                                                                                                     |
| `spentByA`, `spentByB` | Amounts declared in the close request.                                                                                              |
| `event_id`             | Monotonic counter of accepted events; every response carries it so a watcher can order events and detect gaps.                      |

All per-period vars are reset to `false` (deleted) on close; `period` and
`event_id` keep growing.

### Bounce fee

The AA uses the default bounce fee of **10 000 bytes**: every trigger must
carry at least 10 000 bytes, otherwise ocore bounces it before the AA runs.
When a trigger bounces (any failed `require(...)` below, or no case matched), the
sender gets the money back minus 10 000 bytes, which stay on the AA. These
retained fees end up with the larger party at close (see below).

### Cases

Cases are evaluated top to bottom; **the first matching case wins**. A trigger
that matches no case bounces with `no messages`.

#### 1. Deposit

```
if: trigger from A or B AND
    (asset != base AND trigger.output[asset] > 0
     OR asset == base AND trigger.output[base] > 10000)
```

- **No close pending** → accepted:
  - `balance{party} += trigger.output[asset]`;
  - `period` is set to `1` if this is the first deposit;
  - response `data`: `{ open: 1, period, <addressA>: newBalanceA, <addressB>: newBalanceB, event_id, trigger_unit }`.
- **Close pending** → refused:
  - response `data`: `{ refused: 1, trigger_unit, event_id }`;
  - refund to the sender: for bytes `amount - 10000`; for an asset the full
    asset amount (the accompanying bytes stay on the AA).
- `event_id` is incremented in both cases.

Notes:

- For bytes the whole output is credited, including the 10 000 bytes that
  would have been the bounce fee.
- For an asset channel the bytes sent along (≥ 10 000 for the bounce fee) are
  **not** credited to anyone's balance; they accumulate on the AA and go to
  the larger party at close.
- Because this case is first, a trigger from a party that carries more than
  10 000 bytes (or any amount of the channel asset) is treated as a deposit
  even if it also has `close`/`confirm`/`fraud_proof` data. Close/confirm
  triggers must carry exactly the bounce fee (10 000 bytes, no asset).
- Deposits from anyone other than A or B match no case and bounce.

#### 2. Start closing

```
if: trigger from A or B AND trigger.data.close AND no close pending
```

Trigger data:

| Field               | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `close`             | Any truthy value.                                                          |
| `period`            | Must equal `var['period']`, else `wrong period`.                           |
| `transferredFromMe` | What the initiator declares it spent to the peer (integer ≥ 0, default 0). |
| `sentByPeer`        | Optional signed package from the peer, proving what the peer spent.        |

`sentByPeer` checks (each failure bounces):

- `signed_message.aa_address == this_address` — not a voucher of another channel;
- `signed_message.period == var['period']` — not a voucher of a past period;
- `is_valid_signed_package(sentByPeer, peerAddress)` — signed by the other party;
- `signed_message.amount_spent` is an integer ≥ 0.

Other fields inside `signed_message` are ignored, which is what lets obbyx put
its binding (`binding`, `payment_amount`) into the same package.

Effect:

- `spentBy{me} = transferredFromMe`, `spentBy{peer} = sentByPeer.amount_spent` (or `0`);
- `close_initiated_by = party`, `close_start_ts = timestamp`, `event_id += 1`;
- response `data`: `{ closing: 1, period, initiated_by, <addressA>: spentByA, <addressB>: spentByB, event_id, trigger_unit }`.

No money moves yet. From now on deposits are refused until the close is
finished.

#### 3. Confirm closure

```
if: trigger.data.confirm AND close pending
```

Checks:

- the sender must be A or B, and the **initiator** may confirm only after
  `close_start_ts + timeout`; the **other party** may confirm at once —
  otherwise `too early`;
- `period` must equal `var['period']`.

Optional `additionalTransferredFromMe` (integer ≥ 0) lets the confirming party
add what it spent on top of the amounts fixed at close (e.g. the peer
initiated the close with an older voucher of ours, and we acknowledge more).

Final balances:

```
balanceA = depositsA - spentByA + spentByB + additionalSpentByB - additionalSpentByA
balanceB = depositsB - spentByB + spentByA + additionalSpentByA - additionalSpentByB
final    = max(balance, 0)
```

A negative balance is clamped to 0 (comment in the source: possible if an
unconfirmed deposit was not accounted for).

Payout — the party with the **smaller** final balance gets an exact amount,
the **larger** one (on a tie A counts as larger: `finalA >= finalB` → B gets
the exact amount, A the send-all) gets a send-all output and therefore pays the network fees and collects
everything else left on the AA, including accumulated bounce fees:

| Channel asset | Smaller party                 | Larger party                    |
| ------------- | ----------------------------- | ------------------------------- |
| bytes         | `final + 10000` bytes         | send-all bytes                  |
| custom asset  | `final` asset + `10000` bytes | send-all asset + send-all bytes |

Then: response `data` `{ closed: 1, period, event_id }`, `period += 1`, all
per-period vars cleared, `event_id += 1`.

#### 4. Fraud proof

```
if: trigger.data.fraud_proof AND close pending AND trigger.data.sentByPeer
```

`sentByPeer` must be a package signed by the **close initiator** for this AA
and this period (same checks as in _Start closing_). If its `amount_spent` is
**strictly greater** than what the initiator declared it spent
(`spentBy{initiator}`), the initiator lied in its own favour:

- the **wronged party** (the one that did not initiate the close) receives
  **everything** on the AA: send-all bytes and, for an asset channel, send-all
  asset — whoever submitted the proof (v1.2; in v1.1 it was the trigger sender);
- response `data`: `{ closed: 1, fraud_proof: 1, period, event_id }`;
- `period += 1`, per-period vars cleared, `event_id += 1`.

Otherwise it bounces with `the peer didn't lie in his favor`.

The sender of the fraud proof is not checked to be a party: anyone holding a
higher voucher signed by the initiator may submit it, but the payout goes to
the wronged party, so nobody gains by submitting a proof against the other
side's interest. The voucher must still be valid for `is_valid_signed_package`:
only the keys `signed_message`, `authors`, `version` (no `timestamp`, no
`last_ball_unit`, no version `1.0`); obbyx refuses any other shape as a payment
(`verifyVoucherPackage`), because such a voucher could never be used on-chain.

### Lifecycle

```
            deposit (A or B)                     deposit while closing → refused + refund
   ┌──────────────┐                                        ▲
   ▼              │                                        │
 [open, period N] ─┴── close (A or B, spent amounts) ──► [closing]
                                                           │
             ┌─────────────────────────────────────────────┼──────────────────────────┐
             │ confirm by the other party (any time)       │ confirm by the initiator │ fraud_proof (anyone,
             │                                             │ after timeout            │ higher voucher of initiator)
             ▼                                             ▼                          ▼
     payout by final balances                     payout by final balances    everything → wronged party
             └────────────────────────── period N+1, balances reset ─────────────────┘
```

### How obbyx drives it (one-way channel, A = seller, B = client)

- **Open**: B creates the channel definition and makes the first deposit in
  the same unit (the definition is published and funded at once).
- **Pay**: for each request B signs a package
  `{ aa_address, period, amount_spent: <cumulative>, … }`. The seller's watcher
  stores the highest one.
- **Seller closes**: A sends `close` with `transferredFromMe: 0` and
  `sentByPeer` = B's highest voucher, so `spentByB` is fixed by B's own
  signature; B can confirm at once, otherwise A confirms after `timeout`.
- **Client closes**: B sends `close` declaring `transferredFromMe`. If B
  understates it, the watcher submits `fraud_proof` with a higher voucher and
  the seller receives the whole balance; if B is honest, the watcher confirms.
  The client must therefore declare at least the highest voucher it ever
  signed, and must not sign anything after starting the close (the CLI keeps a
  durable `maxSigned` and a closing flag for this).
- This is why the watcher must stay online and hold bytes for these triggers,
  and why the minimum channel `timeout` (at least 3600 s) is enforced to be
  larger than the maximum tolerated watcher downtime plus the stabilisation lag:
  a client's dishonest close must be answered before the client can confirm it.
