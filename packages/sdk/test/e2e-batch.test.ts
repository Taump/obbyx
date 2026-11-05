import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  HTTPFacilitatorClient,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { OBYTE_NETWORKS, channelAddress, channelDefinition } from '@obbyx/obyte';
import { createLogger } from '@obbyx/obyte/logger';
import { BatchObyteClient, ClientChannelStore, type SqliteBatchStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatcherStore } from '../../../apps/watcher/src/storage/store.js';
import type { FacilitatorLink } from '../../../apps/watcher/src/facilitator/link.js';
import { addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { type ChannelStack, hubClient, startChannelStack, until } from './channel-stack.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { payingFetch } from '../src/client/paying-fetch.js';
import { ObytePaywall } from '../src/seller/paywall.js';

const NET = OBYTE_NETWORKS.testnet;
const clientKey = testKey('client');
const client = addressOf(clientKey);
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const params = { addressA: seller, addressB: client, asset: 'base', salt: 'e2e', timeout: 7200 };
const AA = channelAddress(params);
const AA_KEY = `${NET.caip2}:aa:${AA}`;
const silent = process.env['E2E_LOG'] ? createLogger({ level: 'debug' }) : silentLogger();

let hub: FakeHub;
let stack: ChannelStack;
let server: Server;
let base: string;
let link: FacilitatorLink;
let facilitatorBatch: SqliteBatchStore;
let watcherStore: WatcherStore;
let channels: ClientChannelStore;
let handlerCalls: number;

beforeEach(async () => {
  hub = new FakeHub();
  hub.definitions.set(AA, channelDefinition(params));
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000_000 });

  stack = await startChannelStack({ hub, network: NET, seller, sellerKey, logger: silent });
  ({ link, watcherStore, batchStore: facilitatorBatch } = stack);

  const paywall = new ObytePaywall({
    facilitator: new HTTPFacilitatorClient({ url: stack.facilitatorUrl }),
    network: NET.caip2,
    payTo: seller,
    sellerId: 'api',
    secret: 's'.repeat(32),
    store: new ConsumedProofsStore(':memory:'),
    logger: silent,
    batch: { minChannelTimeoutSeconds: 3600 },
    settleWaitMs: 300,
    settlePollMs: 50,
  });
  handlerCalls = 0;
  const app = express();
  app.use(express.json());
  app.post(
    '/api/q',
    paywall.paid({ price: { amount: '100' } }, (req) => {
      handlerCalls += 1;
      return { body: { answer: (req.body as { q: string }).q.toUpperCase() } };
    }),
  );
  app.post(
    '/api/auth',
    paywall.paid({ price: { amount: '100' }, flow: 'authorization' }, (req) => {
      handlerCalls += 1;
      return { body: { answer: (req.body as { q: string }).q } };
    }),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  channels = new ClientChannelStore(':memory:');
  channels.add({
    network: NET.caip2,
    aa: AA,
    payTo: seller,
    asset: 'base',
    timeout: 7200,
    salt: 'e2e',
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

const ask = (q: string, header?: string, pendingTimeoutMs = 120_000) =>
  payingFetch(
    `${base}/api/q`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q }),
      ...(header ? { paymentHeader: header } : {}),
    },
    {
      mechanisms: { batch: batchClient() },
      network: NET.caip2,
      maxAmount: new Map([['base', 1_000n]]),
      logger: silent,
      pendingTimeoutMs,
    },
  );

/**
 * A voucher signed for the CURRENT offer of `q` with a deposit the client
 * believes in (`claimedBalance`), bypassing the client's own balance check.
 */
async function signDespiteBalance(q: string, claimedBalance: number) {
  const offer = await fetch(`${base}/api/q`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q }),
  });
  const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
  const accepted = required.accepts.find((a) => a.scheme === 'batch-settlement')!;
  const truth = hub.aaVars.get(AA);
  hub.aaVars.set(AA, { ...truth, balanceB: claimedBalance });
  const signed = await batchClient().createPaymentPayload(2, accepted);
  hub.aaVars.set(AA, truth!);
  return encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: signed.payload });
}

describe('end to end: AA channel payments (batch-settlement)', () => {
  it('pays per call with cumulative vouchers; the watcher holds every paid voucher', async () => {
    await stack.connectWatcher();

    const first = await ask('a');
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ answer: 'A' });
    expect(first.payment).toMatchObject({
      success: true,
      transaction: '',
      extra: { chargedAmount: '100' },
    });

    const second = await ask('b');
    expect(second.response.status).toBe(200);
    expect(channels.get(AA)).toMatchObject({ committed: 200n, pending: null });
    expect(await watcherStore.best(AA, 1)).toMatchObject({ amountSpent: 200n });
    expect(hub.calls['postJoint']).toBeUndefined(); // no on-chain transaction per call

    const replay = await ask('a', first.paymentHeader!);
    expect(replay.response.status).toBe(200);
    expect(handlerCalls).toBe(2);
  });

  it('without the seller watcher nothing is served (fail-closed); the same payment succeeds once it is back', async () => {
    const first = await ask('x');
    expect(first.response.status).toBe(402);
    expect(handlerCalls).toBe(0);
    // The facilitator refused at verification (watcher not connected): nothing pending anywhere.
    expect(channels.get(AA)?.pending).toBeNull();

    await stack.connectWatcher();
    const paid = await ask('x');
    expect(paid.response.status).toBe(200);
    expect(channels.get(AA)).toMatchObject({ committed: 100n });
  });

  it('a voucher whose ack is lost stays pending; the client signs nothing new until the same operation is retried', async () => {
    await stack.connectWatcher();
    // Simulate a watcher that stops acking (e.g. disk full): stop the link after login.
    const originalSend = WebSocket.prototype.send;
    let blocked = true;
    WebSocket.prototype.send = function (this: WebSocket, data: string) {
      if (blocked && String(data).includes('"ack"')) return;
      originalSend.call(this, data);
    };
    try {
      // Seller and client keep retrying the SAME voucher until the deadline, then give up.
      const pending = await ask('p', undefined, 800).catch((e: unknown) => e);
      expect(pending).toMatchObject({ code: 'settlement_pending' });
      const header = (pending as { paymentHeader: string }).paymentHeader;
      expect(channels.get(AA)?.pending).not.toBeNull();
      expect(handlerCalls).toBe(0);
      await expect(ask('another operation')).rejects.toMatchObject({ code: 'payment_pending' });

      blocked = false;
      const retried = await ask('p', header);
      expect(retried.response.status).toBe(200);
      expect(channels.get(AA)).toMatchObject({ committed: 100n, pending: null });
      expect(handlerCalls).toBe(1);
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  });

  it('a voucher stored by the watcher whose ack was lost is committed after the watcher reconnects', async () => {
    await stack.connectWatcher();
    const originalSend = WebSocket.prototype.send;
    let blocked = true;
    WebSocket.prototype.send = function (this: WebSocket, data: string) {
      if (blocked && String(data).includes('"ack"')) return;
      originalSend.call(this, data);
    };
    try {
      const pending = await ask('lost-ack', undefined, 800).catch((e: unknown) => e);
      expect(pending).toMatchObject({ code: 'settlement_pending' });
      expect((await facilitatorBatch.commitment(1))?.state).toBe('pending');
      // The watcher restarts: its cursor (max stored seq) is already 1.
      blocked = false;
      link.stop();
      await until(() => !link.connected);
      link.start();
      await until(async () => (await facilitatorBatch.commitment(1))?.state === 'committed');
      expect((await facilitatorBatch.channel(AA_KEY))?.pendingSeq).toBeNull();
    } finally {
      WebSocket.prototype.send = originalSend;
    }
  });

  it('a voucher refused before settlement (authorization flow, watcher offline) is released; the next payment works', async () => {
    // Watcher not connected: verify refuses; nothing is stored at the facilitator.
    const call = (q: string) =>
      payingFetch(
        `${base}/api/auth`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q }),
        },
        {
          mechanisms: { batch: batchClient() },
          network: NET.caip2,
          maxAmount: new Map([['base', 1_000n]]),
          logger: silent,
        },
      );
    const refused = await call('x');
    expect(refused.response.status).toBe(402);
    expect(refused.payment).toMatchObject({ success: false, transaction: '' });
    expect(channels.get(AA)?.pending).toBeNull(); // released, not wedged
    await stack.connectWatcher();
    const ok = await call('y');
    expect(ok.response.status).toBe(200);
    expect(channels.get(AA)).toMatchObject({ committed: 100n, pending: null });
  });
});

describe('a buyer can never spend more than the confirmed deposit', () => {
  it('deposit 250, price 100: two calls are paid, the third is refused before anything is signed', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 250 });
    await stack.connectWatcher();
    expect((await ask('one')).response.status).toBe(200);
    expect((await ask('two')).response.status).toBe(200);
    await expect(ask('three')).rejects.toMatchObject({ code: 'channel_exhausted' });
    expect(channels.get(AA)).toMatchObject({ committed: 200n, pending: null });
    expect(handlerCalls).toBe(2);
  });

  it('a client that bypasses its own check is refused by the facilitator (above the deposit)', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 250 });
    await stack.connectWatcher();
    expect((await ask('one')).response.status).toBe(200);
    expect((await ask('two')).response.status).toBe(200);
    // a modified client signs a voucher for 300 although the deposit is 250
    const header = await signDespiteBalance('three', 10_000);
    const res = await fetch(`${base}/api/q`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header },
      body: JSON.stringify({ q: 'three' }),
    });
    expect(res.status).toBe(402);
    expect(decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')!)).toMatchObject({
      success: false,
      errorReason: 'invalid_batch_settlement_obyte_cumulative_exceeds_balance',
    });
    expect(handlerCalls).toBe(2);
  });
});
