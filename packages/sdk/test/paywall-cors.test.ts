import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { createLogger } from '@obbyx/obyte/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { addressOf, testKey } from '../../obyte/test/helpers.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { mergeHeaderList, type PaywallCorsOptions } from '../src/seller/cors.js';
import { ObytePaywall } from '../src/seller/paywall.js';

/**
 * x402 HTTP transport, "Browser clients": the 402 must be readable and the
 * payment sendable from another origin; preflights never require payment.
 */
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });
const APP = 'https://app.example';
let server: Server | undefined;

afterEach(() => server?.close());

async function start(cors?: PaywallCorsOptions): Promise<string> {
  const paywall = new ObytePaywall({
    facilitator: new HTTPFacilitatorClient({ url: 'http://127.0.0.1:9' }),
    network: 'obyte:testnet',
    payTo: addressOf(testKey('seller')),
    sellerId: 'api',
    secret: 's'.repeat(32),
    store: new ConsumedProofsStore(':memory:'),
    logger: silent,
    ...(cors === undefined ? {} : { cors }),
  });
  const app = express();
  app.use(paywall.preflight());
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id'); // set by another middleware
    next();
  });
  app.post(
    '/api/q',
    paywall.paid({ price: { amount: '100' } }, () => ({ body: { ok: true } })),
  );
  server = app.listen(0);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const offer = (base: string, origin?: string) =>
  fetch(`${base}/api/q`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: '{"q":1}',
  });

const preflight = (base: string, origin: string, headers = 'content-type,payment-signature') =>
  fetch(`${base}/api/q`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': headers,
    },
  });

describe('CORS of paid routes', () => {
  it('always exposes the x402 headers, merged with existing ones', async () => {
    const res = await offer(await start());
    expect(res.status).toBe(402);
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-Request-Id, PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull(); // no cors option
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('allows a listed origin on the 402 and reflects it with Vary: Origin', async () => {
    const base = await start({ origins: [APP] });
    const res = await offer(base, APP);
    expect(res.status).toBe(402);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(
      (await offer(base, 'https://evil.example')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('any origin without credentials gets *; with credentials it is reflected', async () => {
    expect(
      (await offer(await start({ origins: '*' }), APP)).headers.get('access-control-allow-origin'),
    ).toBe('*');
    server?.close();
    const res = await offer(await start({ origins: '*', credentials: true }), APP);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('answers the preflight without payment, allowing PAYMENT-SIGNATURE and Content-Type', async () => {
    const base = await start({ origins: [APP], maxAgeSeconds: 900 });
    const res = await preflight(
      base,
      APP,
      'content-type,payment-signature,access-control-expose-headers',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase();
    for (const h of ['payment-signature', 'content-type', 'access-control-expose-headers']) {
      expect(allowed).toContain(h);
    }
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-max-age')).toBe('900');
    expect(
      (await preflight(base, 'https://evil.example')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('merges header lists case-insensitively', () => {
    expect(mergeHeaderList('a, B', ['b', 'C'])).toBe('a, B, C');
    expect(mergeHeaderList(undefined, ['X'])).toBe('X');
    expect(mergeHeaderList(['a', 'b'], ['A'])).toBe('a, b');
  });
});
