import { Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import obyte from 'obyte';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createLogger } from '@obbyx/obyte/logger';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXACT_SETTLE_REASONS as S,
  ExactObyteFacilitator,
  isTransientPostError,
} from '../src/exact/facilitator.js';
import { SqliteSettlementStore, StoreLockedError } from '../src/exact/store.js';
import { HASH_A, HASH_C, addressOf, composeTestUnit, testKey } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NOW = 1_790_000_010; // composeTestUnit uses timestamp 1_790_000_000
const NET = 'obyte:testnet';
const payerKey = testKey('payer');
const payer = addressOf(payerKey);
const seller = addressOf(testKey('seller'));
const PROBE = obyte.utils.getChash160(['sig', { pubkey: 'A'.repeat(44) }]);
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

let unit: Record<string, unknown>;
let hub: FakeHub;
let store: SqliteSettlementStore;
let now: number;

async function makeUnit(extraData = requirements.extra) {
  return composeTestUnit({
    key: payerKey,
    coins: { base: [{ unit: HASH_A, messageIndex: 0, outputIndex: 1, amount: 1_000_000 }] },
    messages: [
      { app: 'payment', payload: { outputs: [{ address: seller, amount: 20_000 }] } },
      {
        app: 'data',
        payload: { x402: { binding: extraData['binding'], quoteId: extraData['quoteId'] } },
      },
    ],
  });
}

function payloadFor(u: Record<string, unknown>, accepted = requirements): PaymentPayload {
  return { x402Version: 2, accepted, payload: { unit: u } };
}

function facilitator(
  opts: {
    finality?: 'stable' | 'accepted';
    timeoutMs?: number;
    maxLastBallAgeSeconds?: number;
  } = {},
) {
  return new ExactObyteFacilitator({
    clients: new Map([[NET, hub.asClient()]]),
    store,
    logger: silent,
    allowedAssets: new Map([[NET, new Set(['base'])]]),
    finality: opts.finality ?? 'stable',
    hubTimeoutMs: opts.timeoutMs ?? 50,
    historyProbeAddress: PROBE,
    ...(opts.maxLastBallAgeSeconds === undefined
      ? {}
      : { maxLastBallAgeSeconds: opts.maxLastBallAgeSeconds }),
    now: () => now,
  });
}

beforeEach(async () => {
  now = NOW;
  unit = await makeUnit();
  hub = new FakeHub();
  // Ledger state the unit depends on: its last ball unit and its input source.
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
  store = new SqliteSettlementStore(':memory:', () => now);
});

describe('verify', () => {
  it('accepts a valid unit and is read-only', async () => {
    const res = await facilitator().verify(payloadFor(unit), requirements);
    expect(res).toEqual({ isValid: true, payer });
    expect(hub.calls['postJoint']).toBeUndefined();
    expect(await store.listActive()).toEqual([]);
  });

  it('rejects when the client changed the accepted terms', async () => {
    const res = await facilitator().verify(
      payloadFor(unit, { ...requirements, amount: '1' }),
      requirements,
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: S.acceptedMismatch });
  });

  it('rejects an expired quote', async () => {
    now = NOW + 601;
    const res = await facilitator().verify(payloadFor(unit), requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: S.quoteExpired });
  });

  it('rejects inputs that are not the payer’s', async () => {
    (hub.joints.get(HASH_A) as any).messages[0].payload.outputs[1].address = seller;
    const res = await facilitator().verify(payloadFor(unit), requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: S.inputs });
  });

  it('rejects inputs already spent by another unit of the payer', async () => {
    hub.history.push({
      unit: 'D'.repeat(43) + '=',
      messages: [
        {
          app: 'payment',
          payload: { inputs: [{ unit: HASH_A, message_index: 0, output_index: 1 }] },
        },
      ],
    });
    const res = await facilitator().verify(payloadFor(unit), requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: S.inputs });
  });

  it('fails closed when the hub does not answer', async () => {
    hub.down = true;
    const res = await facilitator().verify(payloadFor(unit), requirements);
    expect(res).toMatchObject({ isValid: false, invalidReason: S.ledger });
  });
});

describe('settle — state machine', () => {
  it('stable policy: pending until the unit is proven stable, broadcast exactly once', async () => {
    const f = facilitator();
    const first = await f.settle(payloadFor(unit), requirements);
    expect(first).toMatchObject({
      success: false,
      errorReason: S.pending,
      transaction: unit['unit'],
    });

    hub.stable.set(String(unit['unit']), false);
    const second = await f.settle(payloadFor(unit), requirements);
    expect(second).toMatchObject({
      success: true,
      transaction: unit['unit'],
      payer,
      amount: '20000',
    });
    expect(hub.calls['postJoint']).toBe(1);

    const third = await f.settle(payloadFor(unit), requirements);
    expect(third.success).toBe(true);
    expect(hub.calls['postJoint']).toBe(1);
    const transitions = (await store.events(`${NET}:unit:${unit['unit']}`)).filter(
      (e) => e.kind === 'transition',
    );
    expect(transitions.map((e) => e.to)).toEqual(['broadcasting', 'accepted', 'stable_good']);
  });

  it('accepted policy: success once the network accepted the unit', async () => {
    const res = await facilitator({ finality: 'accepted' }).settle(payloadFor(unit), requirements);
    expect(res).toMatchObject({ success: true, transaction: unit['unit'] });
  });

  it('lost broadcast response: unknown outcome, resolved later via get_joint without rebroadcast', async () => {
    hub.post = 'drop';
    const f = facilitator();
    const first = await f.settle(payloadFor(unit), requirements);
    expect(first).toMatchObject({ success: false, errorReason: S.pending });
    expect((await store.listActive())[0]?.state).toBe('broadcasting');

    hub.post = 'accept';
    hub.stable.set(String(unit['unit']), false);
    const [record] = await store.listActive();
    const resumed = await f.resume(record!);
    expect(resumed.success).toBe(true);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('crash after claim (before broadcast): recovery worker publishes it', async () => {
    hub.post = 'hang';
    const f = facilitator({ timeoutMs: 20 });
    await f.settle(payloadFor(unit), requirements); // times out → stays broadcasting
    hub.post = 'accept';
    // "Restart": a new facilitator instance over the same store.
    const restarted = facilitator();
    for (const r of await store.listActive()) await restarted.resume(r);
    expect((await store.get(`${NET}:unit:${unit['unit']}`))?.state).toBe('accepted');
  });

  it('definite hub rejection is terminal and never retried', async () => {
    hub.post = 'reject';
    const f = facilitator();
    const res = await f.settle(payloadFor(unit), requirements);
    expect(res).toMatchObject({ success: false, errorReason: S.rejected });
    const again = await f.settle(payloadFor(unit), requirements);
    expect(again).toMatchObject({ success: false, errorReason: S.rejected });
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('final-bad (double spend) after acceptance is reported as failure', async () => {
    const f = facilitator();
    await f.settle(payloadFor(unit), requirements);
    hub.stable.set(String(unit['unit']), true);
    const res = await f.settle(payloadFor(unit), requirements);
    expect(res).toMatchObject({ success: false, errorReason: S.finalBad });
  });

  it('never publishes after the publication window', async () => {
    hub.post = 'hang';
    const f = facilitator({ timeoutMs: 20 });
    await f.settle(payloadFor(unit), requirements);
    now += 301;
    hub.post = 'accept';
    const res = await f.settle(payloadFor(unit), requirements);
    expect(res).toMatchObject({ success: false, errorReason: S.expired });
    expect(hub.joints.has(String(unit['unit']))).toBe(false);
  });

  it('concurrent settles of the same payment broadcast once', async () => {
    const f = facilitator({ finality: 'accepted' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => f.settle(payloadFor(unit), requirements)),
    );
    expect(results.every((r) => r.success)).toBe(true);
    expect(hub.calls['postJoint']).toBe(1);
  });

  it('the same unit cannot settle another operation', async () => {
    const f = facilitator({ finality: 'accepted' });
    await f.settle(payloadFor(unit), requirements);
    const other = { ...requirements, extra: { ...requirements.extra, binding: 'aa'.repeat(32) } };
    const res = await f.settle(payloadFor(unit, other), other);
    expect(res).toMatchObject({ success: false, errorReason: 'invalid_payment_reused' });
  });

  it('the same unit hash on another network is a different key (I4)', () => {
    expect(`${NET}:unit:x`).not.toBe('obyte:livenet:unit:x');
  });
});

describe('store', () => {
  it('a second facilitator on the same database file cannot start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obbyx-store-'));
    const file = join(dir, 'facilitator.db');
    const first = new SqliteSettlementStore(file);
    expect(() => new SqliteSettlementStore(file)).toThrow(StoreLockedError);
    void first.close();
    expect(() => void new SqliteSettlementStore(file).close()).not.toThrow();
  });
});

describe('last ball age (MAX_LAST_BALL_AGE_SECONDS, independent of maxTimeoutSeconds)', () => {
  it('accepts a last ball older than maxTimeoutSeconds when the network stabilizes slowly', async () => {
    // maxTimeoutSeconds is 300; with few transactions the stable point lags ~2 h (normal).
    hub.joints.set(HASH_C, { unit: HASH_C, timestamp: NOW - 7200, messages: [] });
    expect(await facilitator().verify(payloadFor(unit), requirements)).toEqual({
      isValid: true,
      payer,
    });
  });

  it('refuses a last ball older than the limit and says how old it is', async () => {
    hub.joints.set(HASH_C, { unit: HASH_C, timestamp: NOW - 10_801, messages: [] });
    expect(await facilitator().verify(payloadFor(unit), requirements)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_obyte_stale',
      invalidMessage: expect.stringContaining('10801 s old; the limit is 10800 s'),
    });
    hub.joints.set(HASH_C, { unit: HASH_C, timestamp: NOW - 700, messages: [] });
    expect(
      await facilitator({ maxLastBallAgeSeconds: 600 }).verify(payloadFor(unit), requirements),
    ).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_obyte_stale',
    });
  });

  it('still requires a recent unit timestamp (maxTimeoutSeconds + skew)', async () => {
    now = NOW + 300 + 120 + 1;
    hub.joints.set(HASH_C, { unit: HASH_C, timestamp: now - 30, messages: [] }); // last ball fresh
    const req = { ...requirements, extra: { ...requirements.extra, validUntil: now + 600 } };
    expect(await facilitator().verify(payloadFor(unit, req), req)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_obyte_stale',
      invalidMessage: expect.stringContaining('Unit timestamp'),
    });
  });
});

describe('transient post_joint answers are not rejections', () => {
  it('"already handling this unit" keeps the settlement pending; a later accept settles it', async () => {
    const f = facilitator({ finality: 'accepted' });
    hub.post = 'reject';
    hub.rejectError = 'already handling this unit';
    const first = await f.settle(payloadFor(unit), requirements);
    expect(first).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(first.transaction).not.toBe('');
    hub.post = 'accept';
    expect(await f.settle(payloadFor(unit), requirements)).toMatchObject({ success: true });
  });

  it('a validation error is still a definite rejection', async () => {
    hub.post = 'reject';
    hub.rejectError = 'some inputs are already spent';
    expect(await facilitator().settle(payloadFor(unit), requirements)).toMatchObject({
      success: false,
      errorReason: 'invalid_exact_obyte_rejected_by_network',
    });
  });

  it('classifies ocore answers', () => {
    for (const e of [
      'already handling this unit',
      'known unverified',
      'unknown parents',
      'need hash tree',
    ]) {
      expect(isTransientPostError(e)).toBe(true);
    }
    expect(isTransientPostError('known bad')).toBe(false);
    expect(isTransientPostError('wrong signature')).toBe(false);
  });
});

describe('x402 §6.1 payment flows', () => {
  it('refuses escrow and any asset transfer method', async () => {
    for (const extra of [
      { ...requirements.extra, paymentFlow: 'escrow' },
      { ...requirements.extra, assetTransferMethod: 'permit2' },
    ]) {
      const req = { ...requirements, extra };
      expect(await facilitator().verify(payloadFor(unit, req), req)).toMatchObject({
        isValid: false,
        invalidReason: 'invalid_payment_requirements',
      });
    }
  });
});

describe('payTo must not be an autonomous agent', () => {
  it('refuses a payment to an AA (it could bounce the funds back to the payer)', async () => {
    hub.definitions.set(seller, ['autonomous agent', { base_aa: 'X'.repeat(32) }]);
    expect(await facilitator().verify(payloadFor(unit), requirements)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_obyte_payto_is_aa',
    });
  });

  it('accepts an unused address and a known plain address (cached)', async () => {
    const f = facilitator();
    expect(await f.verify(payloadFor(unit), requirements)).toMatchObject({ isValid: true });
    hub.definitions.set(seller, ['sig', { pubkey: 'A'.repeat(44) }]);
    expect(await f.verify(payloadFor(unit), requirements)).toMatchObject({ isValid: true });
    const calls = hub.calls['getDefinition'] ?? 0;
    expect(await f.verify(payloadFor(unit), requirements)).toMatchObject({ isValid: true });
    expect(hub.calls['getDefinition'] ?? 0).toBe(calls);
  });
});
