import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  HTTPFacilitatorClient,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { OBYTE_NETWORKS, channelAddress, channelDefinition } from '@obbyx/obyte';
import { BatchObyteClient, ClientChannelStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { type ChannelStack, hubClient, startChannelStack } from './channel-stack.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { ObyteBatchServer } from '../src/seller/x402-server.js';

/**
 * Contract test of AA channel payments with the OFFICIAL x402 packages on both
 * ends: @x402/fetch (BatchObyteClient) → @x402/express (ObyteBatchServer) →
 * obbyx facilitator → the seller's watcher.
 */
const NET = OBYTE_NETWORKS.testnet;
const clientKey = testKey('client');
const client = addressOf(clientKey);
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const params = { addressA: seller, addressB: client, asset: 'base', salt: 'x402', timeout: 7200 };
const AA = channelAddress(params);
const silent = silentLogger();

let hub: FakeHub;
let stack: ChannelStack;
let server: Server;
let base: string;
let channels: ClientChannelStore;
let calls: number;

beforeEach(async () => {
  hub = new FakeHub();
  hub.definitions.set(AA, channelDefinition(params));
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000 });
  stack = await startChannelStack({ hub, network: NET, seller, sellerKey, logger: silent });
  await stack.connectWatcher();

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: stack.facilitatorUrl }),
  ).register(
    NET.caip2,
    new ObyteBatchServer({
      sellerId: 'api',
      secret: 's'.repeat(32),
      proofs: new ConsumedProofsStore(':memory:'),
      logger: silent,
      minChannelTimeoutSeconds: 3600,
    }),
  );
  calls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    paymentMiddleware(
      {
        'POST /api/q': {
          accepts: {
            scheme: 'batch-settlement',
            network: NET.caip2,
            payTo: seller,
            price: '100 bytes',
          },
          description: 'A paid query',
        },
      },
      resourceServer,
    ),
  );
  app.post('/api/q', (req, res) => {
    calls += 1;
    res.json({ answer: (req.body as { q: string }).q.toUpperCase() });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  channels = new ClientChannelStore(':memory:');
  channels.add({
    network: NET.caip2,
    aa: AA,
    payTo: seller,
    asset: 'base',
    timeout: 7200,
    salt: 'x402',
    openedUnit: null,
  });
});

// Optional chaining: when beforeEach failed, report that error only.
afterEach(async () => {
  server?.close();
  await stack?.close();
});

const batchClient = () =>
  new BatchObyteClient({
    client: hubClient(hub),
    network: NET,
    privateKey: clientKey,
    store: channels,
    logger: silent,
  });

const officialClient = () =>
  new x402Client()
    .setSpendControls({
      allowedAssets: [{ network: NET.caip2, asset: 'base', maxAmountPerPayment: '1000' }],
    })
    .register(NET.caip2, batchClient());

const post = (f: typeof fetch, q: string, headers: Record<string, string> = {}) =>
  f(`${base}/api/q`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ q }),
  });

describe('contract: @x402/fetch → @x402/express (ObyteBatchServer) → obbyx facilitator + watcher', () => {
  it('offers the channel terms with a per-request binding', async () => {
    const offer = await post(fetch, 'a');
    expect(offer.status).toBe(402);
    const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: 'batch-settlement',
        amount: '100',
        payTo: seller,
        extra: expect.objectContaining({
          minTimeout: 3600,
          baseAa: expect.any(String),
          binding: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    ]);
  });

  it('pays per call with cumulative vouchers; the watcher stores each one', async () => {
    const pay = wrapFetchWithPayment(fetch, officialClient());
    for (const [q, cumulative] of [
      ['a', 100n],
      ['b', 200n],
      ['c', 300n],
    ] as const) {
      const res = await post(pay, q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ answer: q.toUpperCase() });
      expect(decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')!)).toMatchObject({
        success: true,
      });
      // the client confirmed the voucher from the official PAYMENT-RESPONSE hook
      expect(channels.get(AA)).toMatchObject({ committed: cumulative, pending: null });
    }
    expect(calls).toBe(3);
    expect((await stack.watcherStore.best(AA, 1))?.amountSpent).toBe(300n);
  });

  it('a voucher pays for one request only and is never served twice', async () => {
    const offer = await post(fetch, 'once');
    const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
    const header = encodePaymentSignatureHeader(
      await officialClient().createPaymentPayload(required),
    );
    expect((await post(fetch, 'once', { 'PAYMENT-SIGNATURE': header })).status).toBe(200);
    expect((await post(fetch, 'once', { 'PAYMENT-SIGNATURE': header })).status).toBe(402);
    expect((await post(fetch, 'other', { 'PAYMENT-SIGNATURE': header })).status).toBe(402);
    expect(calls).toBe(1);
  });

  it('a call above the deposit is refused before anything is signed', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 150 });
    const pay = wrapFetchWithPayment(fetch, officialClient());
    expect((await post(pay, 'a')).status).toBe(200);
    await expect(post(pay, 'b')).rejects.toThrow();
    expect(calls).toBe(1);
    expect(channels.get(AA)).toMatchObject({ committed: 100n, pending: null });
  });
});
