# SDK

`@obbyx/sdk` has two halves: a **paywall** for sellers (Express) and
**payingFetch** for buyers (agents, services, the CLI).

```sh
npm i @obbyx/sdk @x402/core obyte
npm i express        # for ObytePaywall
```

## Seller: paywall

```ts
import { HTTPFacilitatorClient } from '@x402/core/http';
import { ConsumedProofsStore, ObytePaywall } from '@obbyx/sdk';

const paywall = new ObytePaywall({
  facilitator: new HTTPFacilitatorClient({ url: 'http://127.0.0.1:4021' }),
  network: 'obyte:testnet',
  payTo: 'YOUR_OBYTE_ADDRESS',
  sellerId: 'my-api',
  secret: process.env.SELLER_SECRET!, // ≥ 32 bytes, HMAC key for operation bindings
  store: new ConsumedProofsStore('./data/proofs.db'),
  logger,
  batch: { minChannelTimeoutSeconds: 3600 }, // optional: accept payment channels (needs your watcher)
});

app.post('/api/answer', paywall.paid({ price: { amount: '20000' } }, async (req) => ({ body: { … } })));
```

- Every 402 offer is **bound to the request** (HMAC over method, URL, body,
  price, scheme, quote): a payment can be used for that operation only.
- The handler runs **once per payment**; repeating the same request with the
  same payment returns the stored response.
- Handlers return their response (`{ status?, headers?, body }`) instead of
  writing to `res`, so it can be stored.

### Flows

| Flow                | Order                                | Use for                                                                                                                               |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `upfront` (default) | settle → handler → response          | anything expensive or irreversible, streaming                                                                                         |
| `authorization`     | verify → handler → settle → response | cheap, idempotent handlers only: if the settlement fails afterwards, the handler's side effects happened but the response is withheld |

## Buyer: payingFetch

```ts
import { SpendingBudget, payingFetch } from '@obbyx/sdk';
import { CoinReservations, ExactObyteClient, ReservingComposer } from '@obbyx/x402-obyte';

const composer = new ReservingComposer({
  client,
  network: 'obyte:testnet',
  address,
  reservations: new CoinReservations('./coins.db'),
  logger,
});
const exact = new ExactObyteClient({
  client,
  network: 'obyte:testnet',
  privateKey,
  logger,
  composer,
  maxFee: 10_000n,
});
const budget = new SpendingBudget({
  perCall: new Map([['base', 50_000n]]),
  total: new Map([['base', 1_000_000n]]),
});

const { response, payment } = await payingFetch(
  url,
  { method: 'GET' },
  {
    mechanisms: { exact /*, batch */ },
    network: 'obyte:testnet',
    maxAmount: new Map([['base', 50_000n]]),
    budget,
    logger,
  },
);
```

Safety properties:

| Mechanism           | Guarantees                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ReservingComposer` | concurrent payments from one wallet never pick the same coins; inputs of an unpublished unit are reserved until it appears on the ledger, or until the publication window has passed |
| `SpendingBudget`    | per-call and total limits; amounts are reserved before signing (no overshoot under concurrency); unknown outcomes stay counted                                                       |
| `maxFee`            | an `exact` unit whose network fee exceeds the limit is discarded before it leaves the machine                                                                                        |
| channels            | a channel is preferred when one is open to the seller; while a voucher's outcome is unknown no new one is signed                                                                     |
| retries             | `settlement_pending` is retried with the **same** payment until `pendingTimeoutMs`, then `PaymentPendingError` carries the header to resume later                                    |

## CLI helpers

```sh
obbyx doctor --facilitator http://127.0.0.1:4021   # wallet, hub, balance, pending payments
obbyx logs facilitator.log watcher.log --binding <binding>   # one payment across components
obbyx pay <url> --max 0.00002 --max-fee 10000 --wait 600
```
