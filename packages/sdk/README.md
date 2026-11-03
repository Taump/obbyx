# @obbyx/sdk

Accept and make [x402](https://x402.org) payments on [Obyte](https://obyte.org).

```sh
npm i @obbyx/sdk @x402/core obyte
npm i express            # for ObytePaywall
```

## Sell: `ObytePaywall` (Express)

```ts
import express from 'express';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { createLogger } from '@obbyx/obyte/logger';
import { ConsumedProofsStore, ObytePaywall } from '@obbyx/sdk';

const paywall = new ObytePaywall({
  facilitator: new HTTPFacilitatorClient({ url: 'https://your-facilitator.example' }),
  network: 'obyte:testnet',
  payTo: 'YOUR_OBYTE_ADDRESS',
  sellerId: 'my-api',
  secret: process.env.SELLER_SECRET!, // ≥ 32 chars, HMAC key of request bindings
  store: new ConsumedProofsStore('./data/proofs.db'),
  logger: createLogger(),
});

const app = express();
app.use(express.json());
app.post(
  '/api/answer',
  paywall.paid({ price: { amount: '20000' } }, async () => ({ body: { answer: 42 } })),
);
```

One payment pays one operation (binding over method, URL, body and price); the
handler runs once; a repeated request with the same payment gets the stored
response. Optional: payment channels (`batch`), `payment-identifier`,
`authorization` flow.

## Sell with the official `@x402/express`: `ObyteExactServer`

```ts
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ConsumedProofsStore, ObyteExactServer } from '@obbyx/sdk';

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url })).register(
  'obyte:testnet',
  new ObyteExactServer({
    sellerId: 'api',
    secret: SELLER_SECRET,
    proofs: new ConsumedProofsStore('proofs.db'),
    logger,
  }),
);
app.use(
  paymentMiddleware(
    {
      'GET /x': {
        accepts: { scheme: 'exact', network: 'obyte:testnet', payTo, price: '20000 bytes' },
      },
    },
    server,
  ),
);
```

## Buy: `payingFetch` with budgets

```ts
import { SpendingBudget, payingFetch } from '@obbyx/sdk';

const { response, payment } = await payingFetch(
  url,
  { method: 'GET' },
  {
    mechanisms: { exact /*, batch */ }, // from @obbyx/x402-obyte
    network: 'obyte:testnet',
    maxAmount: new Map([['base', 50_000n]]), // per call
    budget: new SpendingBudget({ total: new Map([['base', 1_000_000n]]) }),
    logger,
  },
);
```

Never pays twice: a pending payment is retried with the same payment; unknown
outcomes stay counted against the budget; a channel is used when one is open,
otherwise `exact`.

Docs: [github.com/Taump/obbyx](https://github.com/Taump/obbyx). Node.js ≥ 24. MIT.
