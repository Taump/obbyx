# @obbyx/cli

`obbyx` — pay [x402](https://x402.org) APIs with [Obyte](https://obyte.org) from the command line.

```sh
npm i -g @obbyx/cli
obbyx init                     # wallet: ~/.obbyx/wallet-testnet.json (mode 0600)
obbyx faucet                   # free testnet bytes
obbyx pay https://api.example/paid --max 0.00002
```

| Command                                               | Does                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `init`, `address`, `balance`                          | local wallet                                                                                      |
| `faucet`                                              | testnet bytes from the Faucet Bot                                                                 |
| `pay <url> --max <GBYTE>`                             | call a paid API, paying at most `--max`; never pays twice (`--payment` resumes a pending payment) |
| `channel open\|list\|status\|deposit\|close\|confirm` | payment channels: instant, fee-free per call                                                      |
| `doctor`                                              | wallet, hub, balance, pending payments                                                            |
| `logs <files> --binding B`                            | follow one payment through JSON logs                                                              |
| `decode <header>`                                     | decode an x402 header                                                                             |

`--network testnet|livenet` (default testnet). Every command has `--help`.
Exit codes: 0 ok, 1 error, 2 refused, 3 pending.

Part of [obbyx](https://github.com/Taump/obbyx). Node.js ≥ 24. MIT.
