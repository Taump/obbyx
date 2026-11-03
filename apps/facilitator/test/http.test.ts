import { Writable } from 'node:stream';
import { HTTPFacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createLogger } from '@obbyx/obyte/logger';
import { SqliteSettlementStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { loadFacilitatorConfig } from '../src/config.js';
import { MemoryCatalog } from '../src/discovery/catalog.js';
import { buildOpenApi } from '../src/http/openapi.js';
import { type FacilitatorApp, buildFacilitator } from '../src/http/server.js';
import {
  HASH_A,
  HASH_C,
  addressOf,
  composeTestUnit,
  testKey,
} from '../../../packages/obyte/test/helpers.js';
import { FakeHub } from '../../../packages/x402-obyte/test/fake-hub.js';

const NOW = 1_790_000_010;
const NET = 'obyte:testnet';
const payerKey = testKey('payer');
const payer = addressOf(payerKey);
const seller = addressOf(testKey('seller'));
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: NET,
  asset: 'base',
  amount: '20000',
  payTo: seller,
  maxTimeoutSeconds: 300,
  extra: { binding: 'f0'.repeat(32), quoteId: 'quote-0001', validUntil: NOW + 600 },
};

let app: FacilitatorApp;
let hub: FakeHub;
let payload: PaymentPayload;

beforeEach(async () => {
  hub = new FakeHub();
  hub.joints.set(HASH_C, { unit: HASH_C, timestamp: NOW - 30, messages: [] });
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
  const unit = await composeTestUnit({
    key: payerKey,
    coins: { base: [{ unit: HASH_A, messageIndex: 0, outputIndex: 1, amount: 1_000_000 }] },
    messages: [
      { app: 'payment', payload: { outputs: [{ address: seller, amount: 20_000 }] } },
      { app: 'data', payload: { x402: { binding: 'f0'.repeat(32), quoteId: 'quote-0001' } } },
    ],
  });
  payload = { x402Version: 2, accepted: requirements, payload: { unit } };
  app = buildFacilitator({
    config: loadFacilitatorConfig({ NETWORKS: NET, HUB_TIMEOUT_MS: '200' }),
    logger: silent,
    store: new SqliteSettlementStore(':memory:', () => NOW),
    clients: new Map([[NET, hub.asClient()]]),
    now: () => NOW,
  });
});

afterEach(async () => {
  await app.http.close();
});

describe('facilitator HTTP API', () => {
  it('GET /supported lists exact on Obyte testnet with the obyte:* signer family', async () => {
    const res = await app.http.inject({ method: 'GET', url: '/supported' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: NET,
          extra: { finality: 'stable', assets: ['base'] },
        },
        { x402Version: 1, scheme: 'exact', network: 'obyte-testnet' },
      ],
      extensions: [],
      signers: { 'obyte:*': [] },
    });
  });

  it('POST /verify and /settle follow the x402 shapes', async () => {
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
    const verify = await app.http.inject({ method: 'POST', url: '/verify', payload: body });
    expect(verify.json()).toEqual({ isValid: true, payer });

    const pending = await app.http.inject({ method: 'POST', url: '/settle', payload: body });
    expect(pending.json()).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      network: NET,
    });

    hub.stable.set(String((payload.payload['unit'] as { unit: string }).unit), false);
    const settled = await app.http.inject({ method: 'POST', url: '/settle', payload: body });
    expect(settled.json()).toMatchObject({ success: true, payer, network: NET, amount: '20000' });
  });

  it('malformed JSON → 400 invalid_json; missing fields → 400 missing_parameters', async () => {
    const bad = await app.http.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ isValid: false, invalidReason: 'invalid_json' });
    const missing = await app.http.inject({
      method: 'POST',
      url: '/verify',
      payload: { x402Version: 2 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ invalidReason: 'missing_parameters' });
  });

  it('an unregistered scheme is reported as unsupported_scheme', async () => {
    const other = { ...requirements, scheme: 'upto' };
    const res = await app.http.inject({
      method: 'POST',
      url: '/verify',
      payload: {
        x402Version: 2,
        paymentPayload: { ...payload, accepted: other },
        paymentRequirements: other,
      },
    });
    expect(res.json()).toMatchObject({ isValid: false, invalidReason: 'unsupported_scheme' });
  });

  it('rejects oversized bodies', async () => {
    const res = await app.http.inject({
      method: 'POST',
      url: '/verify',
      payload: { x402Version: 2, junk: 'x'.repeat(70_000) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('contract: official @x402/core HTTPFacilitatorClient', () => {
  it('talks to our facilitator over HTTP', async () => {
    const address = await app.http.listen({ host: '127.0.0.1', port: 0 });
    const client = new HTTPFacilitatorClient({ url: address });
    const supported = await client.getSupported();
    expect(supported.kinds.map((k) => `${k.scheme}@${k.network}`)).toEqual([
      `exact@${NET}`,
      'exact@obyte-testnet',
    ]);
    expect(await client.verify(payload, requirements)).toMatchObject({ isValid: true, payer });
    hub.stable.set(String((payload.payload['unit'] as { unit: string }).unit), false);
    const settled = await client.settle(payload, requirements);
    expect(settled).toMatchObject({ success: true, network: NET });
  });
});

describe('EXTENSION-RESPONSES (bazaar)', () => {
  const withCatalog = () =>
    buildFacilitator({
      config: loadFacilitatorConfig({ NETWORKS: NET, FINALITY: 'accepted', HUB_TIMEOUT_MS: '200' }),
      logger: silent,
      store: new SqliteSettlementStore(':memory:', () => NOW),
      clients: new Map([[NET, hub.asClient()]]),
      catalog: new MemoryCatalog(),
      now: () => NOW,
    });
  const header = (res: { headers: Record<string, unknown> }) =>
    JSON.parse(
      Buffer.from(String(res.headers['extension-responses']), 'base64').toString(),
    ) as Record<string, unknown>;

  it('after a successful settle: success for a valid declaration, rejected for an invalid one, nothing without bazaar', async () => {
    const f = withCatalog();
    try {
      const bazaar = declareDiscoveryExtension({
        method: 'GET',
        input: { q: 'x' },
        inputSchema: { properties: { q: { type: 'string' } } },
      } as Parameters<typeof declareDiscoveryExtension>[0]);
      const ok = await f.http.inject({
        method: 'POST',
        url: '/settle',
        payload: {
          x402Version: 2,
          paymentPayload: {
            ...payload,
            resource: { url: 'https://api.example/x' },
            extensions: bazaar,
          },
          paymentRequirements: requirements,
        },
      });
      expect(ok.json()).toMatchObject({ success: true });
      expect(header(ok)).toEqual({ bazaar: { status: 'success' } });

      const broken = {
        bazaar: {
          info: { input: { type: 'http', method: 'GET', queryParams: { q: 5 } } },
          schema: (bazaar as unknown as { bazaar: { schema: unknown } }).bazaar.schema,
        },
      };
      const bad = await f.http.inject({
        method: 'POST',
        url: '/settle',
        payload: {
          x402Version: 2,
          paymentPayload: {
            ...payload,
            resource: { url: 'https://api.example/y' },
            extensions: broken,
          },
          paymentRequirements: requirements,
        },
      });
      expect(header(bad)).toMatchObject({ bazaar: { status: 'rejected' } });

      const plain = await f.http.inject({
        method: 'POST',
        url: '/settle',
        payload: { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements },
      });
      expect(plain.headers['extension-responses']).toBeUndefined();
    } finally {
      await f.http.close();
    }
  });

  it('a free /verify never writes to the catalog', async () => {
    const catalog = new MemoryCatalog();
    const f = buildFacilitator({
      config: loadFacilitatorConfig({ NETWORKS: NET, HUB_TIMEOUT_MS: '200' }),
      logger: silent,
      store: new SqliteSettlementStore(':memory:', () => NOW),
      clients: new Map([[NET, hub.asClient()]]),
      catalog,
      now: () => NOW,
    });
    try {
      const bazaar = declareDiscoveryExtension({
        method: 'GET',
        input: { q: 'x' },
      } as Parameters<typeof declareDiscoveryExtension>[0]);
      const res = await f.http.inject({
        method: 'POST',
        url: '/verify',
        payload: {
          x402Version: 2,
          paymentPayload: {
            ...payload,
            resource: { url: 'https://victim.example/api' },
            extensions: bazaar,
          },
          paymentRequirements: requirements,
        },
      });
      expect(res.json()).toMatchObject({ isValid: true });
      expect(res.headers['extension-responses']).toBeUndefined();
      expect((await catalog.list({ limit: 10, offset: 0 })).total).toBe(0);
    } finally {
      await f.http.close();
    }
  });
});

describe('x402 v1 (exact)', () => {
  const v1req = {
    scheme: 'exact',
    network: 'obyte-testnet',
    maxAmountRequired: '20000',
    resource: 'https://api.example/x',
    description: '',
    mimeType: 'application/json',
    outputSchema: {},
    payTo: seller,
    maxTimeoutSeconds: 300,
    asset: 'base',
    extra: requirements.extra,
  };
  const v1body = () => ({
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network: 'obyte-testnet',
      payload: payload.payload,
    },
    paymentRequirements: v1req,
  });

  it('/supported lists the v1 kind with the plain network name', async () => {
    const res = await app.http.inject({ method: 'GET', url: '/supported' });
    const kinds = (res.json() as { kinds: { x402Version: number; network: string }[] }).kinds;
    expect(kinds).toContainEqual(
      expect.objectContaining({ x402Version: 1, network: 'obyte-testnet' }),
    );
  });

  it('verifies and settles a v1 payment; settle reports the v1 network name', async () => {
    const verify = await app.http.inject({ method: 'POST', url: '/verify', payload: v1body() });
    expect(verify.json()).toEqual({ isValid: true, payer });
    hub.stable.set(String((payload.payload['unit'] as { unit: string }).unit), false);
    const settled = await app.http.inject({ method: 'POST', url: '/settle', payload: v1body() });
    expect(settled.json()).toMatchObject({ success: true, payer, network: 'obyte-testnet' });
  });

  it('a proof settled through v1 cannot be settled again through v2 (shared store)', async () => {
    hub.stable.set(String((payload.payload['unit'] as { unit: string }).unit), false);
    expect(
      (await app.http.inject({ method: 'POST', url: '/settle', payload: v1body() })).json(),
    ).toMatchObject({
      success: true,
    });
    const other = { ...requirements, extra: { ...requirements.extra } };
    const v2 = await app.http.inject({
      method: 'POST',
      url: '/settle',
      payload: {
        x402Version: 2,
        paymentPayload: { ...payload, accepted: other },
        paymentRequirements: other,
      },
    });
    // Idempotent replay of the SAME settlement is allowed; it must not broadcast again.
    expect(hub.calls['postJoint']).toBe(1);
    expect(v2.json()).toMatchObject({ network: NET });
  });

  it('rejects a v1 payload whose network does not match the requirements', async () => {
    const body = v1body();
    body.paymentPayload.network = 'obyte-livenet';
    const res = await app.http.inject({ method: 'POST', url: '/verify', payload: body });
    expect(res.json()).toMatchObject({ isValid: false });
  });
});

describe('OpenAPI', () => {
  it('documents exactly the registered routes (and is served)', async () => {
    const routes: string[] = [];
    const f = buildFacilitator({
      config: loadFacilitatorConfig({ NETWORKS: NET }),
      logger: silent,
      store: new SqliteSettlementStore(':memory:'),
      clients: new Map([[NET, hub.asClient()]]),
      catalog: new MemoryCatalog(),
    });
    // Fastify lists routes after ready(); HEAD is auto-added for GET.
    await f.http.ready();
    const tree = f.http.printRoutes({ commonPrefix: false });
    for (const line of tree.split('\n')) {
      const m = /([/\w.-]+) \(([A-Z, ]+)\)/.exec(line.replace(/^[\s│├└─]+/, ''));
      if (m?.[1] && m[2])
        for (const method of m[2].split(', '))
          if (method !== 'HEAD') routes.push(`${method} ${m[1]}`);
    }
    const doc = buildOpenApi();
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(routes.sort()).toEqual(documented.sort());
    const served = await f.http.inject({ method: 'GET', url: '/openapi.json' });
    expect(served.json()).toMatchObject({ openapi: '3.1.0' });
    await f.http.close();
  });
});

describe('unexpected errors during /settle are fail-safe', () => {
  it('a store failure after broadcast is reported as pending with the unit hash, never as a definite failure', async () => {
    const real = new SqliteSettlementStore(':memory:', () => NOW);
    let failAccepted = true;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'transition') {
          return async (...args: Parameters<SqliteSettlementStore['transition']>) => {
            if (failAccepted && args[2] === 'accepted') {
              failAccepted = false;
              throw new Error('disk full');
            }
            return target.transition(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const f = buildFacilitator({
      config: loadFacilitatorConfig({ NETWORKS: NET, FINALITY: 'accepted', HUB_TIMEOUT_MS: '200' }),
      logger: silent,
      store: flaky,
      clients: new Map([[NET, hub.asClient()]]),
      now: () => NOW,
    });
    try {
      const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
      const first = await f.http.inject({ method: 'POST', url: '/settle', payload: body });
      const unitHash = (payload.payload['unit'] as { unit: string }).unit;
      expect(first.json()).toMatchObject({
        success: false,
        errorReason: 'settlement_pending',
        transaction: unitHash,
      });
      expect(hub.calls['postJoint']).toBe(1);
      // The same request later completes; the unit is not broadcast again.
      const second = await f.http.inject({ method: 'POST', url: '/settle', payload: body });
      expect(second.json()).toMatchObject({ success: true, transaction: unitHash });
      expect(hub.calls['postJoint']).toBe(1);
    } finally {
      await f.http.close();
    }
  });
});
