import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { OBYTE_NETWORKS } from '@obbyx/obyte';
import { ExactObyteClient, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { ConsumedProofsStore, ObytePaywall, payingFetch } from '@obbyx/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../../facilitator/src/config.js';
import { type FacilitatorApp, buildFacilitator } from '../../facilitator/src/http/server.js';
import {
  HASH_A,
  HASH_C,
  addressOf,
  testKey,
  silentLogger,
} from '../../../packages/obyte/test/helpers.js';
import { FakeHub } from '../../../packages/x402-obyte/test/fake-hub.js';
import { type Step, tracingFetch } from '../src/playground/playground.js';
import { offlineComposer } from '../../../packages/x402-obyte/test/offline-composer.js';

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
  const url = await facilitator.http.listen({ host: '127.0.0.1', port: 0 });
  const paywall = new ObytePaywall({
    facilitator: new HTTPFacilitatorClient({ url }),
    network: NET,
    payTo: seller,
    sellerId: 'demo',
    secret: 's'.repeat(32),
    store: new ConsumedProofsStore(':memory:'),
    logger: silent,
  });
  const app = express();
  app.get(
    '/api/fortune',
    paywall.paid({ price: { amount: '10000' } }, () => ({ body: { fortune: 'ok' } })),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.close();
  await facilitator.http.close();
});

describe('playground trace', () => {
  it('records request → 402 offer → paid request (unit hash only) → settled response', async () => {
    const steps: Step[] = [];
    const res = await payingFetch(
      `${base}/api/fortune`,
      {},
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
        maxAmount: new Map([['base', 10_000n]]),
        logger: silent,
        fetch: tracingFetch(steps, OBYTE_NETWORKS.testnet),
      },
    );
    expect(res.response.status).toBe(200);
    expect(steps.map((s) => (s.kind === 'response' ? `response ${s.status}` : s.kind))).toEqual([
      'request',
      'response 402',
      'request',
      'response 200',
    ]);
    const [, offer, paid, done] = steps;
    expect(offer).toMatchObject({ offer: [{ scheme: 'exact', amount: '10000', payTo: seller }] });
    expect(paid).toMatchObject({
      payment: { scheme: 'exact', x402Version: 2, unit: expect.any(String) },
    });
    expect(done).toMatchObject({ settlement: { success: true }, body: { fortune: 'ok' } });
    expect((done as { explorer?: string }).explorer).toContain('testnetexplorer.obyte.org');
    // nothing secret in the trace: no full unit, no signatures
    expect(JSON.stringify(steps)).not.toMatch(/authentifiers|"messages"/);
  });
});
