import { Writable } from 'node:stream';
import obyte from 'obyte';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { CHANNEL_BASE_AA, channelAddress, channelDefinition } from '@obbyx/obyte';
import { createLogger } from '@obbyx/obyte/logger';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchObyteFacilitator } from '../src/batch/facilitator.js';
import type { WatcherGateway } from '../src/batch/gateway.js';
import { BATCH_REASONS as R } from '../src/batch/requirements.js';
import { SqliteBatchStore, type CommitmentRow } from '../src/batch/store.js';
import { SqliteSettlementStore } from '../src/exact/store.js';
import { addressOf, testKey } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NET = 'obyte:testnet';
const NOW = 1_790_000_000;
const clientKey = testKey('client');
const client = addressOf(clientKey);
const seller = addressOf(testKey('seller'));
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });
const params = { addressA: seller, addressB: client, asset: 'base', salt: 's1', timeout: 7200 };
const AA = channelAddress(params);

class FakeGateway implements WatcherGateway {
  healthy = true;
  ack: 'acked' | 'timeout' = 'acked';
  delivered: CommitmentRow[] = [];
  health() {
    return this.healthy ? { ok: true } : { ok: false, reason: 'watcher offline' };
  }
  async deliver(c: CommitmentRow) {
    this.delivered.push(c);
    return this.ack;
  }
}

let hub: FakeHub;
let gateway: FakeGateway;
let store: SqliteBatchStore;

const requirements = (binding = 'f0'.repeat(32), amount = '100'): PaymentRequirements => ({
  scheme: 'batch-settlement',
  network: NET,
  asset: 'base',
  amount,
  payTo: seller,
  maxTimeoutSeconds: 60,
  extra: {
    binding,
    quoteId: 'quote-0001',
    validUntil: NOW + 300,
    baseAa: CHANNEL_BASE_AA,
    minTimeout: 3600,
  },
});

function voucher(
  amountSpent: number,
  opts: {
    binding?: string;
    period?: number;
    aa?: string;
    key?: Uint8Array;
    testnet?: boolean;
  } = {},
) {
  return obyte.utils.signMessage(
    {
      aa_address: opts.aa ?? AA,
      period: opts.period ?? 1,
      amount_spent: amountSpent,
      payment_amount: 100,
      binding: opts.binding ?? 'f0'.repeat(32),
    },
    { privateKey: opts.key ?? clientKey, testnet: opts.testnet ?? true },
  );
}

const payload = (pkg: unknown, req = requirements()): PaymentPayload => ({
  x402Version: 2,
  accepted: req,
  payload: { signedPackage: pkg as Record<string, unknown> },
});

function facilitator(now = NOW) {
  return new BatchObyteFacilitator({
    clients: new Map([[NET, hub.asClient()]]),
    store,
    gateway,
    logger: silent,
    allowedAssets: new Map([[NET, new Set(['base'])]]),
    minChannelTimeoutSeconds: 3600,
    hubTimeoutMs: 100,
    now: () => now,
  });
}

beforeEach(() => {
  hub = new FakeHub();
  hub.definitions.set(AA, channelDefinition(params));
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000 });
  gateway = new FakeGateway();
  store = new SqliteBatchStore(new SqliteSettlementStore(':memory:').database, () => NOW);
});

describe('batch-settlement verify', () => {
  it('accepts a valid first voucher (read-only)', async () => {
    const res = await facilitator().verify(payload(voucher(100)), requirements());
    expect(res).toMatchObject({ isValid: true, payer: client });
    expect(gateway.delivered).toHaveLength(0);
  });

  it.each([
    [
      'channel of another seller',
      () => {
        const other = { ...params, addressA: addressOf(testKey('other')) };
        hub.definitions.set(channelAddress(other), channelDefinition(other));
        hub.aaVars.set(channelAddress(other), { period: 1, balanceB: 1000 });
        return payload(voucher(100, { aa: channelAddress(other) }));
      },
      R.channelParams,
    ],
    [
      'voucher signed by someone else',
      () => payload(voucher(100, { key: testKey('mallory') })),
      R.channelParams,
    ],
    ['voucher signed for livenet', () => payload(voucher(100, { testnet: false })), R.signature],
    [
      'voucher bound to another operation',
      () => payload(voucher(100, { binding: 'aa'.repeat(32) })),
      R.binding,
    ],
    ['unknown channel', () => payload(voucher(100, { aa: 'Z'.repeat(32) })), R.channel],
    ['wrong period', () => payload(voucher(100, { period: 2 })), R.period],
    ['amount above confirmed deposit', () => payload(voucher(1_100)), R.balance],
    ['skipped cumulative amount', () => payload(voucher(200)), R.cumulative],
  ])('rejects %s', async (_name, make, reason) => {
    const res = await facilitator().verify(make(), requirements());
    expect(res).toMatchObject({ isValid: false, invalidReason: reason });
  });

  it('rejects a closing channel and a too-short dispute window', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 1000, close_initiated_by: 'B' });
    expect(await facilitator().verify(payload(voucher(100)), requirements())).toMatchObject({
      invalidReason: R.closing,
    });
    const short = { ...params, salt: 's2', timeout: 60 };
    hub.definitions.set(channelAddress(short), channelDefinition(short));
    hub.aaVars.set(channelAddress(short), { period: 1, balanceB: 1000 });
    expect(
      await facilitator().verify(
        payload(voucher(100, { aa: channelAddress(short) })),
        requirements(),
      ),
    ).toMatchObject({ invalidReason: R.timeout });
  });

  it('fails closed when the seller has no healthy watcher', async () => {
    gateway.healthy = false;
    expect(await facilitator().verify(payload(voucher(100)), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.watcher,
    });
  });
});

describe('batch-settlement settle', () => {
  it('commits only after the watcher ack, then accumulates', async () => {
    const f = facilitator();
    const first = await f.settle(payload(voucher(100)), requirements());
    expect(first).toMatchObject({
      success: true,
      transaction: '',
      extra: { chargedAmount: '100', channelState: { chargedCumulativeAmount: '100', period: 1 } },
    });
    expect(gateway.delivered.map((c) => c.amountSpent)).toEqual([100n]);

    const second = await f.settle(
      payload(voucher(200, { binding: 'f1'.repeat(32) }), requirements('f1'.repeat(32))),
      requirements('f1'.repeat(32)),
    );
    expect(second).toMatchObject({
      success: true,
      extra: { channelState: { chargedCumulativeAmount: '200' } },
    });
  });

  it('replaying the same voucher is idempotent; using it for another operation is refused', async () => {
    const f = facilitator();
    const pkg = voucher(100);
    await f.settle(payload(pkg), requirements());
    const again = await f.settle(payload(pkg), requirements());
    expect(again.success).toBe(true);
    expect(gateway.delivered).toHaveLength(1);
    const other = await f.settle(
      payload(pkg, requirements('aa'.repeat(32))),
      requirements('aa'.repeat(32)),
    );
    expect(other).toMatchObject({ success: false, errorReason: R.binding });
  });

  it('no watcher ack → settlement_pending, voucher stays pending, channel busy; retrying the same voucher succeeds', async () => {
    const f = facilitator();
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    expect(await f.settle(payload(pkg), requirements())).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: `${NET}:${AA}:1:100`,
    });
    const next = voucher(200, { binding: 'f1'.repeat(32) });
    expect(
      await f.settle(payload(next, requirements('f1'.repeat(32))), requirements('f1'.repeat(32))),
    ).toMatchObject({
      success: false,
      errorReason: R.busy,
    });
    gateway.ack = 'acked';
    expect((await f.settle(payload(pkg), requirements())).success).toBe(true);
    expect((await store.channel(`${NET}:aa:${AA}`))?.committed).toBe(100n);
  });

  it('out-of-order vouchers: the later one is refused with the committed amount', async () => {
    const res = await facilitator().settle(payload(voucher(200)), requirements());
    expect(res).toMatchObject({
      success: false,
      errorReason: R.cumulative,
      extra: { chargedCumulativeAmount: '0' },
    });
  });

  it('concurrent different vouchers for one channel: exactly one is committed', async () => {
    const f = facilitator();
    const results = await Promise.all(
      ['f1', 'f2', 'f3'].map((b) =>
        f.settle(
          payload(voucher(100, { binding: b.repeat(32) }), requirements(b.repeat(32))),
          requirements(b.repeat(32)),
        ),
      ),
    );
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(gateway.delivered).toHaveLength(1);
  });
});

describe('batch-settlement payment event journal', () => {
  it('records pending → committed, ack timeouts and refusals; a failing journal never breaks a payment', async () => {
    const events: { key: string; kind: string; data?: Record<string, unknown> }[] = [];
    const make = (sink: (e: (typeof events)[number]) => Promise<void>) =>
      new BatchObyteFacilitator({
        clients: new Map([[NET, hub.asClient()]]),
        store,
        gateway,
        logger: silent,
        allowedAssets: new Map([[NET, new Set(['base'])]]),
        minChannelTimeoutSeconds: 3600,
        hubTimeoutMs: 100,
        now: () => NOW,
        events: sink,
      });
    const f = make(async (e) => void events.push(e));

    expect((await f.settle(payload(voucher(100)), requirements())).success).toBe(true);
    gateway.ack = 'timeout';
    const b2 = 'f1'.repeat(32);
    await f.settle(payload(voucher(200, { binding: b2 }), requirements(b2)), requirements(b2));
    await f.settle(
      payload(voucher(900, { binding: 'f2'.repeat(32) }), requirements('f2'.repeat(32))),
      requirements('f2'.repeat(32)),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'voucher_pending',
      'voucher_committed',
      'voucher_pending',
      'ack_timeout',
      'voucher_refused',
    ]);
    expect(events[1]).toMatchObject({
      key: `${NET}:aa:${AA}`,
      data: { seq: 1, amountSpent: '100' },
    });
    expect(events[4]?.data).toMatchObject({
      reason: 'invalid_batch_settlement_obyte_channel_busy',
    });

    gateway.ack = 'acked';
    const broken = make(async () => {
      throw new Error('disk full');
    });
    expect(
      (
        await broken.settle(
          payload(voucher(200, { binding: b2 }), requirements(b2)),
          requirements(b2),
        )
      ).success,
    ).toBe(true);
  });
});

describe('a stored (pending) voucher is never reported as a definite failure', () => {
  it('re-settle after watcher loss, quote expiry and a closing channel stays pending, then commits', async () => {
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    const first = await facilitator().settle(payload(pkg), requirements());
    expect(first).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(first.transaction).not.toBe('');

    // Everything that would refuse a NEW voucher now fails:
    gateway.healthy = false;
    hub.aaVars.set(AA, { period: 1, balanceB: 1_000, close_initiated_by: client });
    const later = facilitator(NOW + 10_000); // quote long expired
    const again = await later.settle(payload(pkg), requirements());
    expect(again).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(again.transaction).toBe(first.transaction);

    // The watcher comes back and acks the SAME voucher: success, nothing refused in between.
    gateway.ack = 'acked';
    const done = await later.settle(payload(pkg), requirements());
    expect(done).toMatchObject({ success: true });
  });

  it('a NEW voucher is still refused when the watcher is offline or the quote expired', async () => {
    gateway.healthy = false;
    expect(await facilitator().settle(payload(voucher(100)), requirements())).toMatchObject({
      success: false,
      errorReason: 'invalid_batch_settlement_obyte_watcher_unavailable',
      transaction: '',
    });
    gateway.healthy = true;
    expect(
      await facilitator(NOW + 10_000).settle(payload(voucher(100)), requirements()),
    ).toMatchObject({
      success: false,
      errorReason: 'invalid_batch_settlement_obyte_quote_expired',
    });
  });
});
