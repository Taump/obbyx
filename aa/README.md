# Payment channel AA (base AA v1.1)

`channels_base_aa_1.1.oscript` is the base autonomous agent of
[aa-channels-lib](https://github.com/Papabyte/aa-channels-lib) together with
its original aa-testkit tests (`test/`, `package.json`).

The original `channels_base_aa_1.1.ojson` is deployed at the same address on
mainnet and testnet:

```
4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ
```

`channels_base_aa_1.1.oscript` is that AA rewritten in modern Oscript
(`require(...)` instead of `if (...) bounce(...)`, a shared
`$get_spent_by_peer` function for checking the peer's signed package, formulas
in backticks). The logic, the response data and the bounce messages are the
same, and the original tests pass unchanged except for reading the error text
(see `errMsg` in `test/bootload.js`). The changes are in
`channels_base_aa_1.1.ojson-to-oscript.diff`.

The AA address is the chash of the definition text, so the rewritten file has
a **different address**, `5KHQT6E6SUVD35D7NVXWEKZNNNHG7ZVM`. It is deployed on
testnet only; obbyx still uses `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`. The original
`.ojson` is in the git history of this folder and on-chain (the definition of
`4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`).

obbyx never deploys this file. Every channel is a **parameterized AA** that
references the deployed base AA; the file is kept here for reading, reviewing
and testing the channel logic.

- How obbyx uses channels: [docs/guide/channels.md](../docs/guide/channels.md)
- Design and binding: [ADR-0003](../docs/adr/0003-batch-settlement-binding-and-watcher.md)
- Trust model and risks: [ADR-0001](../docs/adr/0001-trust-model.md)
- Address derivation / definition parsing: [packages/obyte/src/channel/definition.ts](../packages/obyte/src/channel/definition.ts)

## Contents

| Path | What it is |
| --- | --- |
| `channels_base_aa_1.1.oscript` | The base AA (modern Oscript). |
| `channels_base_aa_1.1.ojson-to-oscript.diff` | Diff from the deployed `.ojson` to the `.oscript`. |
| `test/test_with_bytes_1.1.oscript.js` | Scenarios for a channel in bytes (`asset: 'base'`). |
| `test/test_with_assets_1.1.oscript.js` | The same scenarios for a channel in a custom asset. |
| `test/test_obbyx_binding.oscript.js` | obbyx: `binding`/`payment_amount` in signed packages, tampering, ADR-0001 fraud-proof risk. |
| `test/test_obbyx_watcher_actions.oscript.js` | obbyx: exact `close`/`confirm`/`fraud_proof` triggers of the watcher and the CLI. |
| `test/bootload.js`, `test/mocha.opts` | mocha bootstrap: global `expect`, `errMsg` and chai helpers from aa-testkit. |
| `package.json` | Isolated test package (mocha, chai, aa-testkit). |

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
package, ADR-0001 fraud-proof risk) and `test/test_obbyx_watcher_actions.oscript.js`
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
balances. If the closing party understated what it spent, the other party
submits a **fraud proof** and takes everything.

After a close the channel is not destroyed: `period` is incremented and the
same AA address can be funded and used again.

In obbyx the channel is used one-way: **A = seller** (payee, x402 `payTo`),
**B = client** (payer). Only B deposits, only B signs vouchers.

### Parameters

A channel AA is defined as

```json
["autonomous agent", {
  "base_aa": "4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ",
  "params": { "addressA": "…", "addressB": "…", "asset": "base", "salt": "…", "timeout": 86400 }
}]
```

| Param | Meaning |
| --- | --- |
| `addressA`, `addressB` | The two parties. Only triggers from these addresses can deposit, close or confirm. |
| `asset` | `'base'` for bytes, otherwise a 44-char asset id. One channel = one asset. |
| `timeout` | Dispute window in **seconds** (compared with `timestamp`). |
| `salt` | Optional, not read by the AA. Only changes the address, so the same pair can have several channels. |

The channel address is the chash of this definition, so it is fully determined
by the parameters. obbyx recomputes it from the on-chain definition instead of
trusting parameters from a voucher (`parseChannelDefinition`).

### State variables

| Var | Meaning |
| --- | --- |
| `period` | Current period, starts at `1` on the first accepted deposit, `+1` after each close. Vouchers are valid only for the current period. |
| `balanceA`, `balanceB` | Total deposited by each party in this period. |
| `close_initiated_by` | `'A'` / `'B'` while a close is pending, otherwise unset. |
| `close_start_ts` | Timestamp of the close request. |
| `spentByA`, `spentByB` | Amounts declared in the close request. |
| `event_id` | Monotonic counter of accepted events; every response carries it so a watcher can order events and detect gaps. |

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

| Field | Meaning |
| --- | --- |
| `close` | Any truthy value. |
| `period` | Must equal `var['period']`, else `wrong period`. |
| `transferredFromMe` | What the initiator declares it spent to the peer (integer ≥ 0, default 0). |
| `sentByPeer` | Optional signed package from the peer, proving what the peer spent. |

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

| Channel asset | Smaller party | Larger party |
| --- | --- | --- |
| bytes | `final + 10000` bytes | send-all bytes |
| custom asset | `final` asset + `10000` bytes | send-all asset + send-all bytes |

Then: response `data` `{ closed: 1, period, event_id }`, `period += 1`, all
per-period vars cleared, `event_id += 1`.

#### 4. Fraud proof

```
if: trigger.data.fraud_proof AND close pending AND trigger.data.sentByPeer
```

`sentByPeer` must be a package signed by the **close initiator** for this AA
and this period (same checks as in *Start closing*). If its `amount_spent` is
**strictly greater** than what the initiator declared it spent
(`spentBy{initiator}`), the initiator lied in its own favour:

- the trigger sender receives **everything** on the AA: send-all bytes and, for
  an asset channel, send-all asset;
- response `data`: `{ closed: 1, fraud_proof: 1, period, event_id }`;
- `period += 1`, per-period vars cleared, `event_id += 1`.

Otherwise it bounces with `the peer didn't lie in his favor`.

Note that the sender of the fraud proof is **not** checked to be a party: any
holder of a higher voucher signed by the initiator can submit it and take the
whole balance. This is the trust-model risk described in ADR-0001 — a client
voucher must not leak while that client's close is pending.

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
     payout by final balances                     payout by final balances    everything → sender
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
  receives the whole balance; if B is honest, the watcher confirms.
- This is why the watcher must stay online and hold bytes for these triggers,
  and why the minimum channel `timeout` is enforced to be larger than the
  maximum tolerated watcher downtime.
