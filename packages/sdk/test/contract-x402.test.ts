import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  HTTPFacilitatorClient,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { Network } from '@x402/core/types';
import { ExactObyteClient, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../../../apps/facilitator/src/config.js';
import {
  type FacilitatorApp,
  buildFacilitator,
} from '../../../apps/facilitator/src/http/server.js';
import { HASH_A, HASH_C, addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { ExactObyteServer } from '../src/seller/x402-server.js';
import { payingFetch } from '../src/client/paying-fetch.js';
import { ObytePaywall } from '../src/seller/paywall.js';
import { offlineComposer } from '../../x402-obyte/test/offline-composer.js';

/**
 * Contract test with the OFFICIAL x402 packages on both ends:
 * @x402/fetch (client) → @x402/express (seller) → our facilitator (HTTP).
 */
const NET = 'obyte:testnet';
const payerKey = testKey('payer');
const payer = addressOf(payerKey);
const seller = addressOf(testKey('seller'));
const silent = silentLogger();
const nowSec = () => Math.floor(Date.now() / 1000);

const composer = () => offlineComposer(payer);

let hub: FakeHub;
let facilitator: FacilitatorApp;
let server: Server;
let base: string;
let calls: number;
let failNext = false;

beforeEach(async () => {
  hub = new FakeHub();
  hub.joints.set(HASH_C, { unit: HASH_C, timestamp: nowSec() - 30, messages: [] });
  hub.joints.set(HASH_A, {
    unit: HASH_A,
    messages: [
      {
        app: 'payment',
        payload: {
          outputs: [
            { address: seller, amount: 5 },
            { address: payer, amount: 1_000_000 },
          ],
        },
      },
    ],
  });
  facilitator = buildFacilitator({
    config: loadFacilitatorConfig({ NETWORKS: NET, FINALITY: 'accepted', HUB_TIMEOUT_MS: '200' }),
    logger: silent,
    store: new SqliteSettlementStore(':memory:'),
    clients: new Map([[NET, hub.asClient()]]),
  });
  const facilitatorUrl = await facilitator.http.listen({ host: '127.0.0.1', port: 0 });

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorUrl }),
  ).register(
    NET,
    new ExactObyteServer({
      sellerId: 'api',
      secret: 's'.repeat(32),
      proofs: new ConsumedProofsStore(':memory:'),
      logger: silent,
    }),
  );
  calls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    paymentMiddleware(
      {
        'POST /api/answer': {
          accepts: { scheme: 'exact', network: NET, payTo: seller, price: '20000 bytes' },
          description: 'An answer',
        },
      },
      resourceServer,
    ),
  );
  app.post('/api/answer', (req, res) => {
    calls += 1;
    if (failNext) {
      failNext = false;
      res.status(500).json({ error: 'boom' });
      return;
    }
    res.json({ answer: 42, q: (req.body as { q: string }).q });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.close();
  await facilitator.http.close();
});

/** Official client with spend controls allowing GBYTE (not a USD default asset) with a cap. */
const officialClient = () =>
  new x402Client()
    .setSpendControls({
      allowedAssets: [{ network: NET, asset: 'base', maxAmountPerPayment: '50000' }],
    })
    .register(
      NET,
      new ExactObyteClient({
        client: composer(),
        network: NET,
        privateKey: payerKey,
        logger: silent,
      }),
    );

const officialFetch = () => wrapFetchWithPayment(fetch, officialClient());

const post = (f: typeof fetch, q: string, headers: Record<string, string> = {}) =>
  f(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ q }),
  });

describe('contract: @x402/fetch → @x402/express → obbyx facilitator (exact on Obyte)', () => {
  it('pays and gets the resource', async () => {
    const res = await post(officialFetch(), 'life');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42, q: 'life' });
    const settle = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')!);
    expect(settle).toMatchObject({ success: true, network: NET, payer });
    expect(calls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('the same payment cannot be used again (one payment, one operation)', async () => {
    let captured: string | undefined;
    const spy: typeof fetch = async (input, init) => {
      // @x402/fetch retries with a Request object, so read headers from both.
      const h =
        new Headers(init?.headers).get('PAYMENT-SIGNATURE') ??
        (input instanceof Request ? input.headers.get('PAYMENT-SIGNATURE') : null);
      if (h !== null) captured = h;
      return fetch(input, init);
    };
    const client = officialClient();
    expect((await post(wrapFetchWithPayment(spy, client), 'once')).status).toBe(200);
    expect(captured).toBeDefined();
    const replay = await post(fetch, 'once', { 'PAYMENT-SIGNATURE': captured! });
    expect(replay.status).toBe(402);
    expect(calls).toBe(1);
  });

  it('two concurrent requests with the same payment are served once', async () => {
    const offer = await post(fetch, 'race');
    const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
    const paymentPayload = await officialClient().createPaymentPayload(required);
    const header = encodePaymentSignatureHeader(paymentPayload);
    const results = await Promise.all([
      post(fetch, 'race', { 'PAYMENT-SIGNATURE': header }),
      post(fetch, 'race', { 'PAYMENT-SIGNATURE': header }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(calls).toBe(1);
  });

  it('a settled payment whose handler failed serves the same operation on retry (no new payment)', async () => {
    const offer = await post(fetch, 'retry');
    const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
    const header = encodePaymentSignatureHeader(
      await officialClient().createPaymentPayload(required),
    );
    failNext = true;
    expect((await post(fetch, 'retry', { 'PAYMENT-SIGNATURE': header })).status).toBe(500);
    const retried = await post(fetch, 'retry', { 'PAYMENT-SIGNATURE': header });
    expect(retried.status).toBe(200);
    expect(calls).toBe(2);
    expect(hub.calls['postJoint']).toBe(1);
    // once served, the payment is used up
    expect((await post(fetch, 'retry', { 'PAYMENT-SIGNATURE': header })).status).toBe(402);
  });

  it('a payment for one request cannot pay for another (binding)', async () => {
    let captured: string | undefined;
    const spy: typeof fetch = async (input, init) => {
      // @x402/fetch retries with a Request object, so read headers from both.
      const h =
        new Headers(init?.headers).get('PAYMENT-SIGNATURE') ??
        (input instanceof Request ? input.headers.get('PAYMENT-SIGNATURE') : null);
      if (h !== null) captured = h;
      return fetch(input, init);
    };
    const client = officialClient();
    // Get a signed payment for q=a without letting it settle: break the facilitator's broadcast.
    // (a hub rejection is deterministic; a hang depends on the hub timeout and machine load)
    hub.post = 'reject';
    await post(wrapFetchWithPayment(spy, client), 'a').catch(() => undefined);
    hub.post = 'accept';
    expect(captured).toBeDefined();
    const other = await post(fetch, 'b', { 'PAYMENT-SIGNATURE': captured! });
    expect(other.status).toBe(402);
    expect(calls).toBe(0);
  });
});

describe('contract: cross-compatibility', () => {
  it('our payingFetch pays an @x402/express seller', async () => {
    const res = await payingFetch(
      `${base}/api/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'x' }),
      },
      {
        mechanisms: {
          exact: new ExactObyteClient({
            client: composer(),
            network: NET,
            privateKey: payerKey,
            logger: silent,
          }),
        },
        network: NET,
        maxAmount: new Map([['base', 50_000n]]),
        logger: silent,
      },
    );
    expect(res.response.status).toBe(200);
    expect(res.payment).toMatchObject({ success: true });
    expect(calls).toBe(1);
  });

  it('the official @x402/fetch pays our ObytePaywall seller', async () => {
    const facilitatorUrl = (facilitator.http.server.address() as AddressInfo).port;
    const paywall = new ObytePaywall({
      facilitator: new HTTPFacilitatorClient({ url: `http://127.0.0.1:${facilitatorUrl}` }),
      network: NET,
      payTo: seller,
      sellerId: 'api',
      secret: 's'.repeat(32),
      store: new ConsumedProofsStore(':memory:'),
      logger: silent,
    });
    let served = 0;
    const app = express();
    app.use(express.json());
    app.post(
      '/ours',
      paywall.paid({ price: { amount: '20000' } }, () => {
        served += 1;
        return { body: { ok: true } };
      }),
    );
    const s = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/ours`;
      const res = await officialFetch()(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"q":1}',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(served).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe('contract: x402 v1 through the official client', () => {
  it('x402Client.registerV1 builds a v1 payment our facilitator verifies and settles', async () => {
    const client = new x402Client()
      .setSpendControls({
        allowedAssets: [
          { network: 'obyte-testnet' as Network, asset: 'base', maxAmountPerPayment: '50000' },
        ],
      })
      .registerV1(
        'obyte-testnet',
        new ExactObyteClient({
          client: composer(),
          network: NET,
          privateKey: payerKey,
          logger: silent,
        }),
      );
    const v1req = {
      scheme: 'exact',
      network: 'obyte-testnet',
      maxAmountRequired: '20000',
      resource: 'https://api.example/v1',
      description: 'v1 resource',
      mimeType: 'application/json',
      outputSchema: {},
      payTo: seller,
      maxTimeoutSeconds: 300,
      asset: 'base',
      extra: { binding: 'ab'.repeat(32), quoteId: 'quote-v1-0001', validUntil: nowSec() + 600 },
    };
    const paymentPayload = await client.createPaymentPayload({
      x402Version: 1,
      accepts: [v1req],
    } as never);
    expect(paymentPayload).toMatchObject({
      x402Version: 1,
      scheme: 'exact',
      network: 'obyte-testnet',
    });

    const url = (facilitator.http.server.address() as AddressInfo).port;
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: v1req }),
      }).then((r) => r.json());
    expect(await post('/verify')).toMatchObject({ isValid: true, payer });
    expect(await post('/settle')).toMatchObject({ success: true, network: 'obyte-testnet' });
    expect(hub.calls['postJoint']).toBe(1);
  });
});
