import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ObbyxError } from '@obbyx/obyte';
import { createLogger } from '@obbyx/obyte/logger';
import type { BatchObyteClient, ExactObyteClient } from '@obbyx/x402-obyte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpendingBudget } from '../src/client/budget.js';
import { payingFetch } from '../src/client/paying-fetch.js';

const NET = 'obyte:testnet';
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });
const offer = (scheme: string): PaymentRequirements => ({
  scheme,
  network: NET,
  asset: 'base',
  amount: '100',
  payTo: 'S'.repeat(32),
  maxTimeoutSeconds: 60,
  extra: { binding: 'b'.repeat(64), quoteId: 'quote-0001', validUntil: 9_999_999_999 },
});

let base: string;
let close: () => void;
const paidWith: string[] = [];

beforeAll(() => {
  const app = express();
  app.get('/x', (req, res) => {
    const header = req.get('payment-signature');
    if (header === undefined) {
      const body = {
        x402Version: 2,
        resource: { url: '/x' },
        accepts: [offer('batch-settlement'), offer('exact')],
      };
      res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(body as never));
      res.status(402).json(body);
      return;
    }
    paidWith.push(decodePaymentSignatureHeader(header).accepted.scheme);
    res.setHeader(
      'PAYMENT-RESPONSE',
      encodePaymentResponseHeader({ success: true, transaction: 'T', network: NET }),
    );
    res.json({ ok: true });
  });
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const exact = {
  createPaymentPayload: async () => ({ x402Version: 2, payload: { unit: { unit: 'U' } } }),
} as unknown as ExactObyteClient;
const channel = (code: string) =>
  ({
    hasChannel: () => true,
    onSettled: () => undefined,
    createPaymentPayload: async () => {
      throw new ObbyxError(code, 'channel cannot pay');
    },
  }) as unknown as BatchObyteClient;

describe('payingFetch offer fallback', () => {
  for (const code of [
    'channel_exhausted',
    'channel_not_funded',
    'channel_closing',
    'payment_pending',
  ]) {
    it(`an unusable channel (${code}) falls back to exact; the budget counts one payment`, async () => {
      const budget = new SpendingBudget({ total: new Map([['base', 1000n]]) });
      const res = await payingFetch(
        `${base}/x`,
        {},
        {
          mechanisms: { exact, batch: channel(code) },
          network: NET,
          maxAmount: new Map([['base', 1000n]]),
          logger: silent,
          budget,
        },
      );
      expect(res.response.status).toBe(200);
      expect(paidWith.at(-1)).toBe('exact');
      expect(budget.used('base')).toBe(100n);
    });
  }

  it('any other channel error is not swallowed', async () => {
    await expect(
      payingFetch(
        `${base}/x`,
        {},
        {
          mechanisms: { exact, batch: channel('ledger_unavailable') },
          network: NET,
          maxAmount: new Map([['base', 1000n]]),
          logger: silent,
        },
      ),
    ).rejects.toThrow(/channel cannot pay/);
  });
});
