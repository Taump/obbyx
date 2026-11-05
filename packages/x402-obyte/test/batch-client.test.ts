import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PaymentRequirements } from '@x402/core/types';
import { CHANNEL_BASE_AA, OBYTE_NETWORKS } from '@obbyx/obyte';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchObyteClient } from '../src/batch/client.js';
import { ClientChannelStore } from '../src/batch/client-store.js';
import { BATCH_REASONS } from '../src/batch/requirements.js';
import { addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NET = OBYTE_NETWORKS.testnet;
const seller = addressOf(testKey('seller'));
const AA = 'A'.repeat(32);
const silent = silentLogger();
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
  const c = hub.obyteClient();
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

  it('a seller that drops or lowers our voucher never lowers what we declare on close', async () => {
    await client.createPaymentPayload(2, req('a'.repeat(64)));
    client.onSettled(req('a'.repeat(64)), mismatch('100'));
    await client.createPaymentPayload(2, req('b'.repeat(64))); // signs 200
    // unauthenticated refusal: the voucher (200) may still be held by the seller
    client.onSettled(req('b'.repeat(64)), {
      success: false,
      errorReason: 'anything',
      transaction: '',
      network: NET.caip2,
    });
    expect(store.get(AA)).toMatchObject({ committed: 100n, maxSigned: 200n, pending: null });
    // the seller now claims we committed 0: committed may follow, maxSigned does not
    await client.createPaymentPayload(2, req('c'.repeat(64))); // signs 200 again
    client.onSettled(req('c'.repeat(64)), mismatch('0'));
    expect(store.get(AA)).toMatchObject({ committed: 0n, maxSigned: 200n });
  });

  it('a new period resets maxSigned', () => {
    store.setPending(AA, {
      binding: 'a'.repeat(64),
      period: 1,
      amountSpent: '700',
      signedPackage: {},
    });
    expect(store.get(AA)?.maxSigned).toBe(700n);
    store.newPeriod(AA, 2);
    expect(store.get(AA)).toMatchObject({ period: 2, committed: 0n, maxSigned: 0n, pending: null });
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

describe('ClientChannelStore migration', () => {
  it('adds max_signed to an old database, seeded from committed and the pending voucher', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obbyx-channels-'));
    const path = join(dir, 'channels.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE client_channels (
      aa TEXT PRIMARY KEY, network TEXT NOT NULL, pay_to TEXT NOT NULL, asset TEXT NOT NULL,
      timeout INTEGER NOT NULL, salt TEXT NOT NULL, period INTEGER NOT NULL,
      committed TEXT NOT NULL, pending_json TEXT, opened_unit TEXT, created_at INTEGER NOT NULL
    ) STRICT`);
    const pending = JSON.stringify({
      binding: 'a'.repeat(64),
      period: 3,
      amountSpent: '900',
      signedPackage: {},
    });
    old
      .prepare(
        `INSERT INTO client_channels VALUES (?, 'n', 'p', 'base', 60, 's', 3, '800', ?, NULL, 0)`,
      )
      .run(AA, pending);
    old
      .prepare(
        `INSERT INTO client_channels VALUES ('B', 'n', 'p', 'base', 60, 's', 1, '50', NULL, NULL, 0)`,
      )
      .run();
    old.close();
    const migrated = new ClientChannelStore(path);
    expect(migrated.get(AA)?.maxSigned).toBe(900n);
    expect(migrated.get('B')?.maxSigned).toBe(50n);
    migrated.close();
    rmSync(dir, { recursive: true });
  });
});
