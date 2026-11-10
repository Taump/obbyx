import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { ObbyxError } from '@obbyx/obyte';
import type { BatchObyteClient, ExactObyteClient } from '@obbyx/x402-obyte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpendingBudget } from '../src/client/budget.js';
import {
  PaymentOutcomeUnknownError,
  payingFetch,
  paymentOutcomeUnknown,
} from '../src/client/paying-fetch.js';
import { silentLogger } from '../../obyte/test/helpers.js';

const NET = 'obyte:testnet';
const silent = silentLogger();
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

describe('unknown payment outcomes are reported with the payment to retry', () => {
  const remembered: string[] = [];
  const paying = {
    hasChannel: () => true,
    onSettled: () => undefined,
    rememberPaymentHeader: (_req: PaymentRequirements, header: string) => remembered.push(header),
    createPaymentPayload: async () => ({
      x402Version: 2,
      payload: { signedPackage: { signed_message: {} } },
    }),
  } as unknown as BatchObyteClient;

  it('a network error after the payment was sent throws PaymentOutcomeUnknownError with the header', async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) throw new TypeError('fetch failed');
      return fetch(input, init);
    };
    const err = await payingFetch(
      `${base}/x`,
      {},
      {
        mechanisms: { batch: paying },
        network: NET,
        maxAmount: new Map([['base', 1000n]]),
        logger: silent,
        fetch: flaky,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentOutcomeUnknownError);
    const header = (err as PaymentOutcomeUnknownError).paymentHeader;
    expect(decodePaymentSignatureHeader(header).accepted.scheme).toBe('batch-settlement');
    // the channel client keeps it with the pending voucher
    expect(remembered.at(-1)).toBe(header);
  });

  it('paymentOutcomeUnknown: 5xx, 409, pending, no PAYMENT-RESPONSE are unknown; success and refusals are not', () => {
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: offer('exact'),
      payload: {},
    } as never);
    const batchHeader = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: offer('batch-settlement'),
      payload: {},
    } as never);
    const r = (status: number, payment?: Record<string, unknown>, h = header) => ({
      response: new Response(null, { status }),
      ...(payment ? { payment: payment as never } : {}),
      paymentHeader: h,
    });
    const refused = {
      success: false,
      errorReason: 'invalid_payload',
      transaction: '',
      network: NET,
    };
    expect(paymentOutcomeUnknown(r(500))).toBe(true);
    expect(paymentOutcomeUnknown(r(502, refused))).toBe(true);
    expect(paymentOutcomeUnknown(r(409))).toBe(true);
    expect(paymentOutcomeUnknown(r(402))).toBe(true);
    expect(paymentOutcomeUnknown(r(402, { ...refused, errorReason: 'settlement_pending' }))).toBe(
      true,
    );
    expect(paymentOutcomeUnknown(r(200, undefined, batchHeader))).toBe(true);
    expect(paymentOutcomeUnknown(r(200))).toBe(false);
    expect(paymentOutcomeUnknown(r(402, refused))).toBe(false);
    expect(paymentOutcomeUnknown(r(200, { success: true, transaction: 'T', network: NET }))).toBe(
      false,
    );
    expect(paymentOutcomeUnknown({ response: new Response(null, { status: 500 }) })).toBe(false);
  });
});
