# Payment channels (batch-settlement)

Channels make paid calls instant and fee-free per call: the buyer deposits once
into an Obyte AA (the deployed base AA `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` of
aa-channels-lib) and then pays each request with a signed **voucher** for the
cumulative amount. Nothing is sent on-chain per call; the seller's **watcher**
closes the channel later and receives the money.

See [ADR-0003](/adr/0003-batch-settlement-binding-and-watcher) for the design
and [ADR-0001](/adr/0001-trust-model) for the trust model.

## Buyer

```sh
obbyx channel open <seller address> --deposit 0.001 --window 3600
obbyx channel status <aa>          # usable once the deposit is credited (stable)
obbyx pay <url> --max 0.00001      # uses the channel automatically
obbyx channel list
obbyx channel deposit <aa> --amount 0.001
obbyx channel close <aa>           # declare what you spent; the seller confirms
obbyx channel confirm <aa>         # only if the seller did not confirm within the window
```

The CLI keeps channel state in `$OBBYX_HOME/channels-<network>.db`. While a
voucher's outcome is unknown, it never signs a new one: retry the same request
(`--payment <header>`) first.

## Seller

1. Run the **facilitator** (both schemes are enabled by default).
2. Run your **watcher** with your seller wallet — it must stay online and hold
   bytes for defensive transactions:

   ```sh
   OBBYX_HOME=~/.obbyx-seller pnpm --filter @obbyx/watcher db:migrate
   OBBYX_HOME=~/.obbyx-seller node apps/watcher/dist/main.js
   ```

3. Offer channels in your paywall: `new ObytePaywall({ …, batch: { minChannelTimeoutSeconds: 3600 } })`
   (demo: `BATCH_MIN_CHANNEL_TIMEOUT=3600`).

A payment succeeds only after **your watcher** has durably stored the voucher
(synchronous ack). If the watcher is offline, channel payments are refused
(fail-closed) and buyers fall back to `exact`.

### Watcher configuration

See the [configuration reference](/reference/configuration#seller-watcher-apps-watcher).
The watcher database holds your vouchers — they are your earnings.

What the watcher does on-chain (triggers from your address, 10 000-byte bounce
fee each):

| Channel state                                                        | Action                              |
| -------------------------------------------------------------------- | ----------------------------------- |
| Client started a close and declared less than it signed              | `fraud_proof` with the best voucher |
| Client started an honest close                                       | `confirm` immediately               |
| You started the close                                                | `confirm` after the dispute window  |
| Open, earned ≥ `CLOSE_AT_AMOUNT` or older than `CLOSE_AFTER_SECONDS` | `close` with the best voucher       |

On every hub (re)connection it re-registers `light/new_aa_to_watch` /
`light/new_address_to_watch` and its push subscription (obyte.js `onConnect`).
