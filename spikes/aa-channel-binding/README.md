# Spike: channel AA accepts `binding` in signed packages

Phase-0 executable check for [ADR-0003](../../docs/adr/0003-batch-settlement-binding-and-watcher.md)
and [ADR-0001](../../docs/adr/0001-trust-model.md). Runs the base channel AA
(`channels_base_aa_1.1.ojson`, copied from Papabyte/aa-channels-lib; identical
to `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` on mainnet and testnet) in a local
[aa-testkit](https://github.com/valyakin/aa-testkit) network.

Not part of the pnpm workspace: aa-testkit pulls ocore and native modules.

```sh
cd spikes/aa-channel-binding
npm install
npm test
```

Expected: all tests pass.

| Test | Proves                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | Seller closes with a client package carrying `binding`/`payment_amount`; seller receives exactly `amount_spent`   |
| 1b   | Changing `binding` after signing makes the AA reject the package                                                  |
| 2    | Trust-model risk: during a client-initiated close, a third party with a higher package receives the whole balance |

`test-watcher-actions.cjs` checks the exact trigger data sent by the seller
watcher and the buyer CLI:

| Test | Proves                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| A    | Watcher `close` with the best voucher; initiator `confirm` bounces before the window and pays the seller `amount_spent` after it |
| B    | Honest client close (`transferredFromMe`) + immediate watcher `confirm` pays the seller `amount_spent`                           |
| C    | Client under-declares → watcher `fraud_proof` → seller receives the whole balance                                                |
