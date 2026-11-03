import { Writable } from 'node:stream';
import type { PaymentRequirements } from '@x402/core/types';
import { CHANNEL_BASE_AA, OBYTE_NETWORKS } from '@obbyx/obyte';
import { createLogger } from '@obbyx/obyte/logger';
import obyte from 'obyte';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchObyteClient } from '../src/batch/client.js';
import { ClientChannelStore } from '../src/batch/client-store.js';
import { BATCH_REASONS } from '../src/batch/requirements.js';
import { addressOf, testKey } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NET = OBYTE_NETWORKS.testnet;
const seller = addressOf(testKey('seller'));
const AA = 'A'.repeat(32);
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });
const req = (binding: string): PaymentRequirements => ({
  scheme: 'batch-settlement',
  network: NET.caip2,
  asset: 'base',
  amount: '100',
  payTo: seller,
  maxTimeoutSeconds: 60,
  extra: {
    binding,
    quoteId: 'quote-0001',
    validUntil: 9_999_999_999,
    baseAa: CHANNEL_BASE_AA,
    minTimeout: 60,
  },
});

let store: ClientChannelStore;
let client: BatchObyteClient;

beforeEach(() => {
  const hub = new FakeHub();
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000_000 });
  const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  c.close();
  Object.assign((c as unknown as { api: object }).api, hub.client.api);
  store = new ClientChannelStore(':memory:');
  store.add({
    network: NET.caip2,
    aa: AA,
    payTo: seller,
    asset: 'base',
    timeout: 3600,
    salt: 's',
    openedUnit: null,
  });
  client = new BatchObyteClient({
    client: c,
    network: NET,
    privateKey: testKey('client'),
    store,
    logger: silent,
    maxAmount: new Map([['base', 1_000n]]),
  });
});

const mismatch = (charged: string) =>
  ({
    success: false,
    errorReason: BATCH_REASONS.cumulative,
    transaction: '',
    network: NET.caip2,
    extra: { chargedCumulativeAmount: charged },
  }) as const;

describe('BatchObyteClient resync (untrusted PAYMENT-RESPONSE)', () => {
  it('never raises the committed amount to a value we did not sign (channel drain)', async () => {
    await client.createPaymentPayload(2, req('a'.repeat(64)));
    client.onSettled(req('a'.repeat(64)), mismatch('999999'));
    expect(store.get(AA)).toMatchObject({ committed: 0n, pending: null });
    const next = await client.createPaymentPayload(2, req('b'.repeat(64)));
    const msg = (next.payload['signedPackage'] as { signed_message: { amount_spent: number } })
      .signed_message;
    expect(msg.amount_spent).toBe(100);
  });

  it('accepts exactly our own pending voucher amount (it was committed earlier)', async () => {
    await client.createPaymentPayload(2, req('a'.repeat(64)));
    client.onSettled(req('a'.repeat(64)), mismatch('100'));
    expect(store.get(AA)).toMatchObject({ committed: 100n, pending: null });
  });

  it('refuses prices above its own limit before signing', async () => {
    await expect(
      client.createPaymentPayload(2, { ...req('c'.repeat(64)), amount: '5000' }),
    ).rejects.toMatchObject({
      code: 'amount_over_limit',
    });
    expect(store.get(AA)?.pending).toBeNull();
  });
});
