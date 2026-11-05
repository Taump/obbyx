# x402 compatibility

obbyx speaks standard x402. The official packages (`@x402/core`, `@x402/fetch`,
`@x402/express`, `@x402/extensions`) work with it unchanged; Obyte support comes
from the scheme mechanisms in `@obbyx/x402-obyte` and the server adapter in `@obbyx/sdk`.
Contract tests run the official packages against obbyx on every CI run
(`packages/sdk/test/contract-*.test.ts`).

## What is supported

| Feature                                   | Status       | Notes                                                                                  |
| ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| x402 v2: `/verify` `/settle` `/supported` | yes          | `exact` and `batch-settlement` on `obyte:testnet` / `obyte:livenet`                    |
| x402 v1                                   | `exact` only | network names `obyte-testnet` / `obyte-livenet`; same mechanism and same store as v2   |
| Bazaar discovery                          | yes          | `GET /discovery/resources`, `GET /discovery/search`; listed in `/supported.extensions` |
| `EXTENSION-RESPONSES` header              | yes          | facilitator → resource server; reports `bazaar` cataloging `success` / `rejected`      |
| `payment-identifier`                      | yes          | in `ObytePaywall` (seller side) and `payingFetch` (client side)                        |
| Official `@x402/fetch` client             | yes          | register `ExactObyteClient` and/or `BatchObyteClient`; set spend controls for GBYTE    |
| Official `@x402/express` seller           | yes          | register `ObyteExactServer` and/or `ObyteBatchServer`; see the limitation below        |
| Browser clients (CORS)                    | yes          | `ObytePaywall({ cors })` + `paywall.preflight()`; with `@x402/express`, the app's CORS |

## Official client (`@x402/fetch`)

```sh
npm i @x402/fetch @obbyx/x402-obyte obyte
```

GBYTE is not one of the client's default (USD) assets, so the client rejects
Obyte offers unless spend controls allow them. Always set a cap:

```ts
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactObyteClient } from '@obbyx/x402-obyte';

const client = new x402Client()
  .setSpendControls({
    allowedAssets: [{ network: 'obyte:testnet', asset: 'base', maxAmountPerPayment: '50000' }],
  })
  .register(
    'obyte:testnet',
    new ExactObyteClient({ client: obyteClient, network: 'obyte:testnet', privateKey }),
  );

const paidFetch = wrapFetchWithPayment(fetch, client);
```

For v1 sellers use `registerV1('obyte-testnet', …)` with the same mechanism and
allow `network: 'obyte-testnet'` in spend controls.

For channel payments register a `BatchObyteClient` too (it needs an open
channel; see [payment channels](./channels.md)). It reads the seller's
PAYMENT-RESPONSE through the client's `onPaymentResponse` hook, so the voucher
is confirmed or released exactly as with `payingFetch`.

## Official seller (`@x402/express`)

```sh
npm i @x402/express @x402/core @obbyx/sdk
```

```ts
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { ObyteExactServer, ConsumedProofsStore } from '@obbyx/sdk';

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  'obyte:testnet',
  new ObyteExactServer({
    sellerId: 'api',
    secret: SELLER_SECRET,
    proofs: new ConsumedProofsStore('proofs.db'),
  }),
);

app.use(
  paymentMiddleware(
    {
      'POST /api/answer': {
        accepts: { scheme: 'exact', network: 'obyte:testnet', payTo, price: '20000 bytes' },
      },
    },
    server,
  ),
);
```

`price` is either `{ asset, amount }` (smallest units) or a string `"<n> bytes"` /
`"<x> GBYTE"`. Obyte has no USD default asset, so `"$0.01"` is rejected.

`ObyteExactServer` adds the per-request binding (an HMAC over the method, URL,
body and price) to every offer, so a payment for one request cannot pay for
another, and it records each proof so it is used for one operation only.

### Channel payments (`batch-settlement`)

Register `ObyteBatchServer` next to (or instead of) `ObyteExactServer`. The
facilitator must run with batch-settlement and your watcher connected;
`minChannelTimeoutSeconds` must match its `MIN_CHANNEL_TIMEOUT_SECONDS`.

```ts
import { ObyteBatchServer } from '@obbyx/sdk';

server.register(
  'obyte:testnet',
  new ObyteBatchServer({
    sellerId: 'api',
    secret: SELLER_SECRET,
    proofs,
    minChannelTimeoutSeconds: 14_400,
  }),
);
// route: accepts: { scheme: 'batch-settlement', network: 'obyte:testnet', payTo, price: '100 bytes' }
```

Both server classes support the `upfront` flow only: the payment is claimed and
settled before the handler runs, so one payment never reaches the handler
twice. A route may list both schemes in `accepts`.

### Browser clients (CORS)

None of the x402 headers is CORS-safelisted. With `ObytePaywall`, pass
`cors: { origins: ['https://app.example'] }` and mount `paywall.preflight()`
before the routes: the 402 then carries `Access-Control-Allow-Origin`, the
expose list keeps any existing names and adds `PAYMENT-REQUIRED` and
`PAYMENT-RESPONSE`, and preflights are answered without payment, allowing
`PAYMENT-SIGNATURE` and `Content-Type` with a 10-minute `Access-Control-Max-Age`.
The official `@x402/express` middleware passes `OPTIONS` through and leaves CORS
to the app, for example with the `cors` package:

```ts
app.use(
  cors({
    origin: ['https://app.example'],
    exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
    allowedHeaders: ['PAYMENT-SIGNATURE', 'Content-Type'],
    maxAge: 600,
  }),
);
```

**Limitation.** The official middleware has no "stored response" path: if the
response to a paid request is lost, the repeated request gets a new 402 instead
of the stored response. A client that must not pay twice should use
`ObytePaywall` + `payingFetch`, which support `payment-identifier` and return the
stored response for a repeated operation.

## `payment-identifier`

The seller declares the extension; the client then sends a client-chosen id
(16–128 chars, `[A-Za-z0-9_-]`) with the payment:

```ts
const paywall = new ObytePaywall({ /* … */ paymentIdentifier: { required: true } });

// client: reuse the SAME id when retrying after a lost response
await payingFetch(url, { method: 'POST', body, paymentId: 'pay_order_42_attempt' }, options);
```

| Situation                                     | Seller response                                                      |
| --------------------------------------------- | -------------------------------------------------------------------- |
| New id                                        | normal payment flow                                                  |
| Same id, same operation, already served       | the stored response; the new payment is **not** settled              |
| Same id, same operation, still in progress    | `409 payment_in_progress`                                            |
| Same id, earlier attempt definitely failed    | normal payment flow with the new payment                             |
| Same id, different operation (URL/body/price) | `409 payment_identifier_conflict`                                    |
| Id missing while required / invalid format    | `400 payment_identifier_required` / `400 invalid_payment_identifier` |

Ids are scoped per `sellerId`. The operation fingerprint does not include the
quote, so a retry with a fresh quote is still "the same operation".

## Bazaar discovery

The facilitator catalogs a resource when a payment for it is **verified** and the
payload carries a valid `extensions.bazaar` declaration (the seller declares it,
e.g. with `declareDiscoveryExtension` and `bazaarResourceServerExtension` from
`@x402/extensions/bazaar`; the client echoes it). Declarations are validated
with the reference implementation; per-request quote fields (`binding`,
`quoteId`, `validUntil`) are stripped from the listing.

```
GET /discovery/resources?network=obyte:testnet&scheme=exact&limit=20&offset=0
GET /discovery/search?query=weather%20forecast&limit=20&cursor=<from previous page>
```

Both endpoints are public and read-only. The result of cataloging is returned to
the resource server in the `EXTENSION-RESPONSES` header (base64 JSON), e.g.
`{"bazaar":{"status":"success"}}` or
`{"bazaar":{"status":"rejected","rejectedReason":"…"}}`. Cataloging never
affects the verify/settle result.

## x402 v1

v1 is accepted for `exact` only. The adapter converts v1 shapes
(`maxAmountRequired`, plain network names, no `accepted`) to v2 and runs the
same mechanism with the same settlement store. Settlement keys use the CAIP-2
network id, so a proof settled through v1 cannot be settled again through v2.
`/settle` answers with the v1 network name. A v1 seller sends the same `extra`
(`binding`, `quoteId`, `validUntil`) as a v2 seller.
