import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import {
  type FacilitatorClient,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import { createLogger } from '@obbyx/obyte/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressOf, testKey } from '../../obyte/test/helpers.js';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { ObytePaywall } from '../src/seller/paywall.js';

const NET = 'obyte:testnet';
const seller = addressOf(testKey('seller'));
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });
const UNIT = 'U'.repeat(43) + '=';

/** A: slow success. B (same payment, concurrent): a refusal before reaching the network. */
let settles = 0;
let releaseA: () => void = () => undefined;
const facilitator = {
  verify: async () => ({ isValid: true }),
  getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
  settle: async (): Promise<SettleResponse> => {
    settles += 1;
    if (settles === 1) {
      await new Promise<void>((r) => (releaseA = r));
      return { success: true, transaction: UNIT, network: NET };
    }
    return {
      success: false,
      errorReason: 'invalid_exact_obyte_stale',
      transaction: '',
      network: NET,
    };
  },
} as unknown as FacilitatorClient;

let base: string;
let close: () => void;
let handlerCalls = 0;

beforeAll(() => {
  const paywall = new ObytePaywall({
    facilitator,
    network: NET,
    payTo: seller,
    sellerId: 'race',
    secret: 's'.repeat(32),
    store: new ConsumedProofsStore(':memory:'),
    logger: silent,
    settleWaitMs: 50,
    settlePollMs: 10,
  });
  const app = express();
  app.get(
    '/x',
    paywall.paid({ price: { amount: '100' } }, () => {
      handlerCalls += 1;
      return { body: { ok: true } };
    }),
  );
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe('concurrent requests with one payment at the seller', () => {
  it('a refused retry never deletes the row of a request that is settling; the payment is served once', async () => {
    const offer = decodePaymentRequiredHeader(
      (await fetch(`${base}/x`)).headers.get('PAYMENT-REQUIRED')!,
    );
    const accepted = offer.accepts[0] as PaymentRequirements;
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { unit: { unit: UNIT } },
    });
    const a = fetch(`${base}/x`, { headers: { 'PAYMENT-SIGNATURE': header } });
    await new Promise((r) => setTimeout(r, 50)); // A is inside settle
    const b = await fetch(`${base}/x`, { headers: { 'PAYMENT-SIGNATURE': header } });
    expect(b.status).toBe(402); // B refused …
    releaseA(); // … A's settlement succeeds afterwards
    expect((await a).status).toBe(200);
    expect(handlerCalls).toBe(1);
    // a later retry with the same payment gets the stored response, not "quote expired"
    const c = await fetch(`${base}/x`, { headers: { 'PAYMENT-SIGNATURE': header } });
    expect(c.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});
