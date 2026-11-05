import { HTTPFacilitatorClient } from '@x402/core/http';
import { SqliteSettlementStore } from '@obbyx/x402-obyte';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../src/config.js';
import { type FacilitatorApp, buildFacilitator } from '../src/http/server.js';
import { FakeHub } from '../../../packages/x402-obyte/test/fake-hub.js';
import { silentLogger } from '../../../packages/obyte/test/helpers.js';

const silent = silentLogger();
let app: FacilitatorApp;
const make = (env: Record<string, string>) => {
  app = buildFacilitator({
    config: loadFacilitatorConfig({ NETWORKS: 'obyte:testnet', ...env }),
    logger: silent,
    store: new SqliteSettlementStore(':memory:'),
    clients: new Map([['obyte:testnet', new FakeHub().asClient()]]),
  });
  return app;
};
afterEach(async () => app?.http.close());

const verify = (headers: Record<string, string> = {}, url = '/verify') =>
  app.http.inject({ method: 'POST', url, headers, payload: { x402Version: 2 } });

describe('protection of /verify and /settle', () => {
  it('open by default (still validated: missing fields → 400)', async () => {
    make({});
    expect((await verify()).statusCode).toBe(400);
  });

  it('with API keys: refuses missing or wrong keys (also with a query string), accepts Bearer or X-API-Key', async () => {
    make({ FACILITATOR_API_KEYS: 'k1-secret,k2-secret' });
    expect((await verify()).json()).toMatchObject({ invalidReason: 'unauthorized' });
    expect((await verify({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await verify({}, '/verify?x=1')).statusCode).toBe(401);
    const settle = await app.http.inject({ method: 'POST', url: '/settle', payload: {} });
    expect(settle.json()).toMatchObject({
      success: false,
      errorReason: 'unauthorized',
      transaction: '',
    });
    expect((await verify({ authorization: 'Bearer k2-secret' })).statusCode).toBe(400);
    expect((await verify({ 'x-api-key': 'k1-secret' })).statusCode).toBe(400);
    // public endpoints stay open
    expect((await app.http.inject({ method: 'GET', url: '/supported' })).statusCode).toBe(200);
  });

  it('rate-limits per client', async () => {
    make({ RATE_LIMIT_PER_MINUTE: '3' });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await verify()).statusCode);
    expect(codes).toEqual([400, 400, 400, 429, 429]);
  });

  it('the official HTTPFacilitatorClient authenticates with createAuthHeaders', async () => {
    make({ FACILITATOR_API_KEYS: 'k1-secret' });
    const url = await app.http.listen({ host: '127.0.0.1', port: 0 });
    const ok = new HTTPFacilitatorClient({
      url,
      createAuthHeaders: async () => {
        const headers = { Authorization: 'Bearer k1-secret' };
        return { verify: headers, settle: headers, supported: headers };
      },
    });
    expect((await ok.getSupported()).kinds.length).toBeGreaterThan(0);
    const anonymous = new HTTPFacilitatorClient({ url });
    await expect(
      anonymous.verify({ x402Version: 2, accepted: {} as never, payload: {} }, {} as never),
    ).rejects.toThrow();
  });
});
