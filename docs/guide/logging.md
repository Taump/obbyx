# Logging

All obbyx packages log through one structured logger (`@obbyx/obyte/logger`,
based on pino). Libraries never call `console`; they receive a logger and
create module children.

## Configuration

| Variable     | Example                      | Meaning                                                        |
| ------------ | ---------------------------- | -------------------------------------------------------------- |
| `LOG_LEVEL`  | `info`                       | Base level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `LOG_LEVELS` | `x402.exact=debug,hub=trace` | Per-module overrides; the most specific prefix wins            |
| `LOG_PRETTY` | `1`                          | Human-readable output for local development                    |

Level guidelines: `error` — invariant violation or lost connection after all
retries; `warn` — retries, `pending` longer than the threshold, watcher lag;
`info` — payment state transitions, start/stop; `debug` — verification
details; `trace` — hub calls.

## Correlation

Fields set with `withLogContext()` are added to every line written in that
async flow: `requestId`, `traceId`, `binding`, `proofId`, `network`, `scheme`,
`x402Version`, `sellerId`, `aa`, `seq`. The same `binding` appears in the
seller middleware, the facilitator and the watcher, so one payment can be
followed end to end:

```sh
jq 'select(.binding == "…")' facilitator.log
```

## Redaction

Payment proofs are bearer-sensitive (see the [trust model](/adr/0001-trust-model)).
Values under these field names are never written; a fingerprint
`[redacted sha256:…]` is logged instead: `authentifiers`, `signedPackage`,
`signed_package`, `sentByPeer`, `paymentPayload`, `paymentSignature`,
`xPayment`, `joint`, `signedUnit`, `apiKey`, `authorization`, `cookie`,
`challengeSignature`, `privateKey`, `mnemonic`, `seed`, `password`, `secret`,
and the headers `payment-signature`, `x-payment`, `authorization`, `cookie`,
`x-api-key`. Code that logs such data must use these field names; use
`fingerprint(value)` to log a correlatable hash explicitly.

## Streams

1. **Technical log** — JSON lines to stdout (pretty with `LOG_PRETTY=1`, which needs the optional `pino-pretty` package; without it the log stays JSON and says so once). The CLI logs to stderr.
2. **Payment event journal** — append-only `events` table of the facilitator:
   `exact` state transitions, `voucher_pending` / `voucher_committed` /
   `voucher_refused` / `ack_timeout`, watcher connections and acks, hub
   outages. Inspect with `pnpm --filter @obbyx/facilitator db:studio`.
3. **Access journal** — every read of a stored channel package is an event of
   kind `package_read` (operation, sequence number, fingerprint) in the same
   table. There is no dashboard, login or admin API in this version.

Follow one payment across files with the CLI:

```sh
obbyx logs facilitator.log demo.log watcher.log --binding <binding>
```
