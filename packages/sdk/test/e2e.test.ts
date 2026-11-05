import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import obyte from 'obyte';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactObyteClient, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../../../apps/facilitator/src/config.js';
import {
  type FacilitatorApp,
  buildFacilitator,
} from '../../../apps/facilitator/src/http/server.js';
import {
  HASH_A,
  HASH_B,
  HASH_C,
  addressOf,
  testKey,
  silentLogger,
} from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { SpendingBudget } from '../src/client/budget.js';
import { payingFetch } from '../src/client/paying-fetch.js';
import { ObytePaywall } from '../src/seller/paywall.js';

const NET = 'obyte:testnet';
const payerKey = testKey('payer');
const payer = addressOf(payerKey);
const seller = addressOf(testKey('seller'));
const silent = silentLogger();
const nowSec = () => Math.floor(Date.now() / 1000);

/** obyte.js client whose hub calls for composing are answered offline. */
function offlineComposer(): obyte.Client {
  const client = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  client.close();
  const c = client as unknown as {
    cachedWitnesses: string[];
    api: Record<string, (p: any) => Promise<unknown>>;
  };
  c.cachedWitnesses = ['W'.repeat(32)];
  c.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
    parent_units: [HASH_B],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1000,
    timestamp: nowSec(),
    tps_fee: 10,
  });
  c.api['getDefinitionForAddress'] = async () => ({ definition_chash: payer, is_stable: true });
  c.api['pickDivisibleCoinsForAmount'] = async () => ({
    inputs_with_proofs: [{ input: { unit: HASH_A, message_index: 0, output_index: 1 } }],
    total_amount: 1_000_000,
  });
  return client;
}

let hub: FakeHub;
let facilitator: FacilitatorApp;
let server: Server;
let base: string;
let handlerCalls: number;
let failNext: boolean;
let proofs: ConsumedProofsStore;

async function start(finality: 'stable' | 'accepted') {
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
    config: loadFacilitatorConfig({ NETWORKS: NET, FINALITY: finality, HUB_TIMEOUT_MS: '200' }),
    logger: silent,
    store: new SqliteSettlementStore(':memory:'),
    clients: new Map([[NET, hub.asClient()]]),
  });
  const facilitatorUrl = await facilitator.http.listen({ host: '127.0.0.1', port: 0 });

  proofs = new ConsumedProofsStore(':memory:');
  const paywall = new ObytePaywall({
    facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }),
    network: NET,
    payTo: seller,
    sellerId: 'demo-api',
    secret: 's'.repeat(32),
    store: proofs,
    logger: silent,
    settleWaitMs: 300,
    settlePollMs: 50,
  });
  handlerCalls = 0;
  failNext = false;
  const app = express();
  app.use(express.json());
  app.post(
    '/api/answer',
    paywall.paid({ price: { amount: '20000' }, description: 'An answer' }, async (req) => {
      handlerCalls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      return { body: { answer: 42, question: req.body.question } };
    }),
  );
  app.post(
    '/api/cheap',
    paywall.paid({ price: { amount: '20000' }, flow: 'authorization' }, async (req) => {
      handlerCalls += 1;
      return { body: { cheap: true, question: req.body.question } };
    }),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const mechanism = () =>
  new ExactObyteClient({
    client: offlineComposer(),
    network: NET,
    privateKey: payerKey,
    logger: silent,
  });
const pay = (body: object, opts: { max?: bigint; header?: string } = {}) =>
  payingFetch(
    `${base}/api/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(opts.header ? { paymentHeader: opts.header } : {}),
    },
    {
      mechanisms: { exact: mechanism() },
      network: NET,
      maxAmount: new Map([['base', opts.max ?? 50_000n]]),
      logger: silent,
    },
  );

async function freshPaymentHeader(question: string): Promise<string> {
  const res = await fetch(`${base}/api/answer`, {
    method: 'POST',
    body: JSON.stringify({ question }),
    headers: { 'content-type': 'application/json' },
  });
  const offer = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!);
  const result = await mechanism().createPaymentPayload(2, offer.accepts[0]!);
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: offer.accepts[0]!,
    payload: result.payload,
  });
}

const sendWith = (header: string, question: string) =>
  fetch(`${base}/api/answer`, {
    method: 'POST',
    body: JSON.stringify({ question }),
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header },
  });

afterEach(async () => {
  server?.close();
  await facilitator?.http.close();
});

describe('end to end: client → seller paywall → facilitator → (fake) hub', () => {
  beforeEach(() => start('accepted'));

  it('unpaid request gets 402 with an x402 v2 PAYMENT-REQUIRED offer', async () => {
    const res = await fetch(`${base}/api/answer`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const offer = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!);
    expect(offer.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: NET,
      amount: '20000',
      payTo: seller,
    });
  });

  it('pays, settles once, serves once; the same payment replays the stored response (I1)', async () => {
    const first = await pay({ question: 'life' });
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ answer: 42, question: 'life' });
    expect(first.payment).toMatchObject({ success: true, network: NET });

    const replay = await pay({ question: 'life' }, { header: first.paymentHeader! });
    expect(replay.response.status).toBe(200);
    expect(await replay.response.json()).toEqual({ answer: 42, question: 'life' });
    expect(handlerCalls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('a payment for one operation cannot be used for another (I1/I2)', async () => {
    const first = await pay({ question: 'life' });
    const other = await pay({ question: 'universe' }, { header: first.paymentHeader! });
    expect(other.response.status).toBe(402);
    expect(await other.response.json()).toMatchObject({ error: 'invalid_binding' });
    expect(handlerCalls).toBe(1);
  });

  it('concurrent first use of one payment: handler runs once, broadcast once (I3)', async () => {
    const header = await freshPaymentHeader('q');
    const responses = await Promise.all(Array.from({ length: 4 }, () => sendWith(header, 'q')));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(handlerCalls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('handler failure after payment: retry with the same payment serves without paying again', async () => {
    failNext = true;
    const first = await pay({ question: 'x' });
    expect(first.response.status).toBe(500);
    const retry = await pay({ question: 'x' }, { header: first.paymentHeader! });
    expect(retry.response.status).toBe(200);
    expect(handlerCalls).toBe(2);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('a settled payment whose handler failed still counts against the budget', async () => {
    const budget = new SpendingBudget({ total: new Map([['base', 20_000n]]) });
    failNext = true;
    const first = await payingFetch(
      `${base}/api/answer`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"x"}' },
      {
        mechanisms: { exact: mechanism() },
        network: NET,
        maxAmount: new Map([['base', 50_000n]]),
        logger: silent,
        budget,
      },
    );
    expect(first.response.status).toBe(500);
    expect(first.payment).toMatchObject({ success: true }); // PAYMENT-RESPONSE on the 500
    expect(budget.used('base')).toBe(20_000n);
  });

  it('a shared total budget is never overshot by concurrent calls', async () => {
    const budget = new SpendingBudget({ total: new Map([['base', 40_000n]]) });
    const call = (q: string) =>
      payingFetch(
        `${base}/api/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        },
        {
          mechanisms: { exact: mechanism() },
          network: NET,
          maxAmount: new Map([['base', 50_000n]]),
          logger: silent,
          budget,
        },
      );
    const results = await Promise.allSettled(['a', 'b', 'c'].map(call));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .map((r) => (r as PromiseRejectedResult).reason.code),
    ).toEqual(['budget_exceeded']);
    expect(budget.used('base')).toBe(40_000n);
  });

  it('a payment that definitely failed gives its budget back', async () => {
    const budget = new SpendingBudget({ total: new Map([['base', 20_000n]]) });
    hub.post = 'reject';
    const failed = await payingFetch(
      `${base}/api/answer`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"z"}' },
      {
        mechanisms: { exact: mechanism() },
        network: NET,
        maxAmount: new Map([['base', 50_000n]]),
        logger: silent,
        budget,
      },
    );
    expect(failed.response.status).toBe(402);
    expect(budget.used('base')).toBe(0n);
  });

  it('the buyer refuses offers above its limit', async () => {
    await expect(pay({ question: 'x' }, { max: 19_999n })).rejects.toMatchObject({
      code: 'amount_over_limit',
    });
    expect(hub.calls['postJoint']).toBeUndefined();
  });
});

describe('end to end with stable finality', () => {
  beforeEach(() => start('stable'));

  it('settlement_pending → 402 with Retry-After; same payment succeeds once stable', async () => {
    const header = await freshPaymentHeader('s');
    const send = () => sendWith(header, 's');

    const pending = await send();
    expect(pending.status).toBe(402);
    expect(pending.headers.get('retry-after')).toBe('5');
    expect(await pending.json()).toMatchObject({ error: 'settlement_pending' });
    expect(handlerCalls).toBe(0);

    const unit = JSON.parse(Buffer.from(header, 'base64').toString()).payload.unit.unit as string;
    hub.stable.set(unit, false);
    const done = await send();
    expect(done.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });
});

describe('authorization flow (verify → handler → settle → send)', () => {
  const cheap = (question: string, header?: string) =>
    payingFetch(
      `${base}/api/cheap`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        ...(header ? { paymentHeader: header } : {}),
      },
      {
        mechanisms: { exact: mechanism() },
        network: NET,
        maxAmount: new Map([['base', 50_000n]]),
        logger: silent,
        pendingTimeoutMs: 300,
      },
    );

  it('runs the handler before settling and sends the response once settled', async () => {
    await start('accepted');
    const res = await cheap('q');
    expect(res.response.status).toBe(200);
    expect(await res.response.json()).toEqual({ cheap: true, question: 'q' });
    expect(handlerCalls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('a settlement failing after the handler withholds the response', async () => {
    await start('accepted');
    hub.post = 'reject';
    const res = await cheap('q');
    expect(res.response.status).toBe(402);
    expect(handlerCalls).toBe(1); // side effects happened — that is why upfront is the default
    expect(await res.response.json()).not.toHaveProperty('cheap');
  });

  it('pending settlement: the stored response is sent on retry with the same payment, handler not re-run', async () => {
    await start('stable');
    const pending = await cheap('s').catch(
      (e: unknown) => e as { paymentHeader: string; code: string },
    );
    expect(pending).toMatchObject({ code: 'settlement_pending' });
    expect(handlerCalls).toBe(1);
    const unit = JSON.parse(
      Buffer.from((pending as { paymentHeader: string }).paymentHeader, 'base64').toString(),
    ).payload.unit.unit as string;
    hub.stable.set(unit, false);
    const done = await cheap('s', (pending as { paymentHeader: string }).paymentHeader);
    expect(done.response.status).toBe(200);
    expect(await done.response.json()).toEqual({ cheap: true, question: 's' });
    expect(handlerCalls).toBe(1);
  });
});

describe('x402 payment-identifier (seller declares it)', () => {
  let pidBase: string;
  let pidServer: Server;
  let pidCalls: number;
  beforeEach(async () => {
    await start('accepted');
    const paywall = new ObytePaywall({
      facilitator: new HTTPFacilitatorClient({
        url: `http://127.0.0.1:${(facilitator.http.server.address() as AddressInfo).port}`,
      }),
      network: NET,
      payTo: seller,
      sellerId: 'api-pid',
      secret: 's'.repeat(32),
      store: new ConsumedProofsStore(':memory:'),
      logger: silent,
      paymentIdentifier: { required: true },
    });
    pidCalls = 0;
    const app = express();
    app.use(express.json());
    app.post(
      '/pid',
      paywall.paid({ price: { amount: '20000' } }, (req) => {
        pidCalls += 1;
        return { body: { n: pidCalls, q: (req.body as { q: string }).q } };
      }),
    );
    pidServer = app.listen(0);
    pidBase = `http://127.0.0.1:${(pidServer.address() as AddressInfo).port}`;
  });
  afterEach(() => pidServer.close());

  const call = (q: string, paymentId?: string) =>
    payingFetch(
      `${pidBase}/pid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q }),
        ...(paymentId ? { paymentId } : {}),
      },
      {
        mechanisms: { exact: mechanism() },
        network: NET,
        maxAmount: new Map([['base', 50_000n]]),
        logger: silent,
      },
    );

  it('a repeated operation with the same id returns the stored response and does not charge again', async () => {
    const id = 'pay_0123456789abcdef0001';
    const first = await call('a', id);
    expect(first.response.status).toBe(200);
    const again = await call('a', id); // a NEW payment is signed, but must not be settled
    expect(again.response.status).toBe(200);
    expect(await again.response.json()).toEqual({ n: 1, q: 'a' });
    expect(pidCalls).toBe(1);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('the same id for a different operation is a conflict (409)', async () => {
    const id = 'pay_0123456789abcdef0002';
    expect((await call('a', id)).response.status).toBe(200);
    expect((await call('b', id)).response.status).toBe(409);
  });

  it('a required id is enforced and its format checked', async () => {
    const offer = await fetch(`${pidBase}/pid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"x"}',
    });
    const required = decodePaymentRequiredHeader(offer.headers.get('PAYMENT-REQUIRED')!);
    expect(required.extensions?.['payment-identifier']).toMatchObject({ info: { required: true } });
    const result = await mechanism().createPaymentPayload(2, required.accepts[0]!);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: required.accepts[0]!,
      payload: result.payload,
    });
    const res = await fetch(`${pidBase}/pid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header },
      body: '{"q":"x"}',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'payment_identifier_required' });
  });
});
