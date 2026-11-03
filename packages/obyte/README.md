# @obbyx/obyte

Obyte primitives used by the obbyx x402 packages.

| Entry                 | Contents                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@obbyx/obyte`        | networks (`obyte:livenet`/`obyte:testnet`, v1 names), BigInt amounts, `validateExactUnit` (payment-unit profile), `verifySignedPackage`, channel AA definitions, `ObbyxError` |
| `@obbyx/obyte/wallet` | single-address wallet file (`$OBBYX_HOME/wallet-<network>.json`, mode 0600), validated on load                                                                                |
| `@obbyx/obyte/logger` | structured logger (pino) with redaction of keys, units and vouchers                                                                                                           |
| `@obbyx/obyte/config` | zod-based environment configuration                                                                                                                                           |

```sh
npm i @obbyx/obyte obyte
```

Part of [obbyx](https://github.com/Taump/obbyx). Node.js ≥ 24. MIT.
