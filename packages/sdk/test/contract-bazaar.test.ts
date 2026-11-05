import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { ExactObyteClient, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../../../apps/facilitator/src/config.js';
import { MemoryCatalog } from '../../../apps/facilitator/src/discovery/catalog.js';
import {
  type FacilitatorApp,
  buildFacilitator,
} from '../../../apps/facilitator/src/http/server.js';
import { HASH_A, HASH_C, addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { ObyteExactServer } from '../src/seller/x402-server.js';
import { offlineComposer } from '../../x402-obyte/test/offline-composer.js';

const NET = 'obyte:testnet';
const payerKey = testKey('payer');
const payer = addressOf(payerKey);
const seller = addressOf(testKey('seller'));
const silent = silentLogger();
const nowSec = () => Math.floor(Date.now() / 1000);

const composer = () => offlineComposer(payer);

let hub: FakeHub;
let facilitator: FacilitatorApp;
let facilitatorUrl: string;
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
    catalog: new MemoryCatalog(),
  });
  facilitatorUrl = await facilitator.http.listen({ host: '127.0.0.1', port: 0 });
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register(
      NET,
      new ObyteExactServer({
        sellerId: 'api',
        secret: 's'.repeat(32),
        proofs: new ConsumedProofsStore(':memory:'),
        logger: silent,
      }),
    )
    .registerExtension(bazaarResourceServerExtension);
  const app = express();
  app.use(express.json());
  app.use(
    paymentMiddleware(
      {
        'GET /api/weather': {
          accepts: { scheme: 'exact', network: NET, payTo: seller, price: '20000 bytes' },
          description: 'Weather forecast for a city',
          serviceName: 'Obbyx Weather',
          tags: ['weather', 'forecast'],
          extensions: declareDiscoveryExtension({
            input: { city: 'Berlin' },
            inputSchema: { properties: { city: { type: 'string' } }, required: ['city'] },
            output: { example: { tempC: 21 } },
          }),
        },
      },
      resourceServer,
    ),
  );
  app.get('/api/weather', (_req, res) => {
    res.json({ tempC: 21 });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.close();
  await facilitator.http.close();
});

describe('contract: Bazaar discovery through the official packages', () => {
  it('a paid resource that declares bazaar is cataloged and discoverable', async () => {
    const client = new x402Client()
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
    const res = await wrapFetchWithPayment(fetch, client)(`${base}/api/weather?city=Berlin`);
    expect(res.status).toBe(200);

    const supported = (await (await fetch(`${facilitatorUrl}/supported`)).json()) as {
      extensions: string[];
    };
    expect(supported.extensions).toContain('bazaar');

    const list = (await (
      await fetch(`${facilitatorUrl}/discovery/resources?network=${NET}`)
    ).json()) as {
      x402Version: number;
      items: {
        resource: string;
        type: string;
        accepts: { scheme: string; extra: Record<string, unknown> }[];
        serviceName?: string;
      }[];
      pagination: { total: number };
    };
    expect(list.x402Version).toBe(2);
    expect(list.pagination.total).toBe(1);
    expect(list.items[0]).toMatchObject({ type: 'http', serviceName: 'Obbyx Weather' });
    expect(list.items[0]?.resource).toContain('/api/weather');
    expect(list.items[0]?.accepts[0]?.extra).not.toHaveProperty('binding'); // per-request quote is not listed

    const found = (await (
      await fetch(`${facilitatorUrl}/discovery/search?query=weather%20forecast`)
    ).json()) as {
      resources: unknown[];
      pagination: { cursor: string | null };
    };
    expect(found.resources).toHaveLength(1);
    expect(found.pagination.cursor).toBeNull();
    const none = (await (
      await fetch(`${facilitatorUrl}/discovery/search?query=stocks`)
    ).json()) as { resources: unknown[] };
    expect(none.resources).toHaveLength(0);
    expect((await fetch(`${facilitatorUrl}/discovery/search`)).status).toBe(400);
  });
});
