import obyte from 'obyte';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { getSignedPackageHashToSign, sign as signHash } from 'obyte/lib/internal.js';
import {
  CHANNEL_BASE_AA,
  LEGACY_CHANNEL_BASE_AAS,
  channelAddress,
  channelDefinition,
  getNetwork,
  networkKey,
} from '@obbyx/obyte';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchObyteFacilitator } from '../src/batch/facilitator.js';
import type { DeliveryOutcome, WatcherGateway } from '../src/batch/gateway.js';
import {
  BATCH_REASONS as R,
  MAX_VOUCHER_AMOUNT,
  parseBatchRequirements,
} from '../src/batch/requirements.js';
import { SqliteBatchStore, type CommitmentRow } from '../src/batch/store.js';
import { packageHashOf } from '../src/batch/watcher-protocol.js';
import { SqliteSettlementStore } from '../src/exact/store.js';
import { addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NET = 'obyte:testnet';
const NOW = 1_790_000_000;
const clientKey = testKey('client');
const client = addressOf(clientKey);
const seller = addressOf(testKey('seller'));
const silent = silentLogger();
const params = { addressA: seller, addressB: client, asset: 'base', salt: 's1', timeout: 7200 };
const AA = channelAddress(params);

class FakeGateway implements WatcherGateway {
  healthy = true;
  closing = new Set<string>();
  ack: 'acked' | 'timeout' | 'refused' = 'acked';
  delivered: CommitmentRow[] = [];
  health(_payTo: string, _network: string, aa?: string) {
    if (aa !== undefined && this.closing.has(aa))
      return { ok: false, closing: true, reason: 'closing' };
    return this.healthy ? { ok: true } : { ok: false, reason: 'watcher offline' };
  }
  /** Like the real gateway: the signed receipt settles the entry BEFORE deliver resolves. */
  async deliver(c: CommitmentRow): Promise<DeliveryOutcome> {
    this.delivered.push(c);
    const owner = { payTo: c.payTo, network: c.network, packageHash: c.packageHash };
    if (this.ack === 'acked') await store.commit(c.seq, owner);
    if (this.ack === 'refused') {
      await store.cancel(c.seq, owner);
      return { kind: 'refused', reason: 'not_increasing' };
    }
    return { kind: this.ack };
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
  it('re-settle after watcher loss and quote expiry stays pending, then commits', async () => {
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    const first = await facilitator().settle(payload(pkg), requirements());
    expect(first).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(first.transaction).not.toBe('');

    // What would refuse a NEW voucher now fails (the channel itself is still open):
    gateway.healthy = false;
    const later = facilitator(NOW + 10_000); // quote long expired
    expect(await later.verify(payload(pkg), requirements())).toMatchObject({ isValid: true });
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

describe('a channel the seller is closing', () => {
  it('refuses new vouchers definitively (channel_closing), not as watcher_unavailable', async () => {
    gateway.closing.add(AA);
    expect(await facilitator().settle(payload(voucher(100)), requirements())).toMatchObject({
      success: false,
      errorReason: 'invalid_batch_settlement_obyte_channel_closing',
      transaction: '',
    });
  });
});

describe('signed watcher receipts: ack commits, nack cancels', () => {
  it('a refused voucher (nack) is a definite failure and frees the channel', async () => {
    gateway.ack = 'refused';
    const first = await facilitator().settle(payload(voucher(100)), requirements());
    expect(first).toMatchObject({ success: false, errorReason: R.refused, transaction: '' });
    const channel = await store.channel(networkKey(getNetwork(NET), 'aa', AA));
    expect(channel).toMatchObject({ pendingSeq: null, committed: 0n });

    // retrying the SAME refused voucher stays refused (verify and settle)
    expect(await facilitator().verify(payload(voucher(100)), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.refused,
    });
    expect(await facilitator().settle(payload(voucher(100)), requirements())).toMatchObject({
      success: false,
      errorReason: R.refused,
    });

    // the next operation (same cumulative amount, new binding) goes through
    gateway.ack = 'acked';
    const req2 = requirements('e1'.repeat(32));
    const next = await facilitator().settle(
      payload(voucher(100, { binding: 'e1'.repeat(32) }), req2),
      req2,
    );
    expect(next).toMatchObject({ success: true });
  });
});

describe('batch store: receipts must name the exact package', () => {
  const append = (amount: bigint, hash: string) =>
    store.appendPending({
      channelKey: 'k',
      network: NET,
      aa: AA,
      payTo: seller,
      payer: client,
      asset: 'base',
      period: 1,
      amountSpent: amount,
      paymentAmount: 100n,
      binding: 'f0'.repeat(32),
      packageHash: hash,
      packageJson: '{}',
    });
  const owner = (packageHash: string) => ({ payTo: seller, network: NET, packageHash });

  it('commit/cancel with another packageHash, seller or network do nothing', async () => {
    const res = await append(100n, 'a'.repeat(64));
    if (!res.ok) throw new Error('append failed');
    const seq = res.commitment.seq;
    expect(await store.commit(seq, owner('b'.repeat(64)))).toBeUndefined();
    expect(await store.cancel(seq, owner('b'.repeat(64)))).toBeUndefined();
    expect(
      await store.commit(seq, { ...owner('a'.repeat(64)), payTo: addressOf(testKey('x')) }),
    ).toBeUndefined();
    expect((await store.commitment(seq))?.state).toBe('pending');
  });

  it('final states are never undone: no commit after cancel, no cancel after commit', async () => {
    const a = await append(100n, 'a'.repeat(64));
    if (!a.ok) throw new Error('append failed');
    expect((await store.cancel(a.commitment.seq, owner('a'.repeat(64))))?.state).toBe('cancelled');
    expect((await store.commit(a.commitment.seq, owner('a'.repeat(64))))?.state).toBe('cancelled');
    expect((await store.channel('k'))?.committed).toBe(0n);

    const b = await append(100n, 'c'.repeat(64));
    if (!b.ok) throw new Error('append failed');
    expect((await store.commit(b.commitment.seq, owner('c'.repeat(64))))?.state).toBe('committed');
    expect((await store.cancel(b.commitment.seq, owner('c'.repeat(64))))?.state).toBe('committed');
    expect((await store.channel('k'))?.committed).toBe(100n);
    // cancelled entries are not replayed to the watcher
    expect((await store.journal(seller, 0)).map((c) => c.seq)).toEqual([b.commitment.seq]);
  });
});

describe('stored pending voucher: the channel is re-read on retry', () => {
  const stuck = async (f = facilitator()) => {
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    expect(await f.settle(payload(pkg), requirements())).toMatchObject({
      errorReason: 'settlement_pending',
    });
    gateway.ack = 'acked';
    return pkg;
  };
  const channelKey = () => networkKey(getNetwork(NET), 'aa', AA);

  it('period closed meanwhile: the entry is cancelled and settle/verify fail', async () => {
    const events: { kind: string; data?: Record<string, unknown> }[] = [];
    const pkg = await stuck();
    hub.aaVars.set(AA, { period: 2, balanceB: 1_000 });
    const f = new BatchObyteFacilitator({
      clients: new Map([[NET, hub.asClient()]]),
      store,
      gateway,
      logger: silent,
      allowedAssets: new Map([[NET, new Set(['base'])]]),
      minChannelTimeoutSeconds: 3600,
      hubTimeoutMs: 100,
      now: () => NOW + 10_000,
      events: async (e) => void events.push(e),
    });
    const res = await f.settle(payload(pkg), requirements());
    expect(res).toMatchObject({ success: false, errorReason: R.period, transaction: '' });
    expect(gateway.delivered).toHaveLength(1); // not re-delivered
    expect(events.map((e) => e.kind)).toContain('voucher_cancelled');
    expect(await store.channel(channelKey())).toMatchObject({ pendingSeq: null, committed: 0n });
    // now cancelled: refused on every later retry, for the real reason (not a watcher nack)
    expect(await f.verify(payload(pkg), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.period,
    });
    expect(await f.settle(payload(pkg), requirements())).toMatchObject({
      success: false,
      errorReason: R.period,
      errorMessage: expect.stringContaining('was cancelled'),
    });
  });

  it('verify of a stored pending voucher for a closed period fails and cancels it', async () => {
    const pkg = await stuck();
    hub.aaVars.set(AA, { period: 2, balanceB: 1_000 });
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.period,
    });
    expect((await store.commitmentByHash(gateway.delivered[0]!.packageHash))?.state).toBe(
      'cancelled',
    );
  });

  it('channel closing: verify leaves it to settle, settle lets the watcher decide', async () => {
    const pkg = await stuck();
    hub.aaVars.set(AA, { period: 1, balanceB: 1_000, close_initiated_by: client });
    // Not a definite refusal: the watcher may still ack it (client's close).
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
    });
    gateway.ack = 'timeout';
    const pending = await facilitator().settle(payload(pkg), requirements());
    expect(pending).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(pending.transaction).not.toBe('');
    gateway.ack = 'acked';
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: true,
    });
    expect(gateway.delivered).toHaveLength(3);
  });

  it('channel closing and the watcher nacks: a definite refusal', async () => {
    const pkg = await stuck();
    hub.aaVars.set(AA, { period: 1, balanceB: 1_000, close_initiated_by: seller });
    gateway.ack = 'refused';
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: false,
      errorReason: R.refused,
    });
  });

  it('ledger unreadable: verify is NOT a definite refusal, the entry stays pending', async () => {
    const f = facilitator(); // caches the channel definition
    const pkg = await stuck(f);
    hub.down = true;
    expect(await f.verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
      payer: client,
    });
    const res = await f.settle(payload(pkg), requirements());
    expect(res).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(res.transaction).not.toBe('');
    expect((await store.commitmentByHash(gateway.delivered[0]!.packageHash))?.state).toBe(
      'pending',
    );
    // Later the hub is back and the watcher acks: the client keeps its voucher and is served.
    hub.down = false;
    expect(await f.settle(payload(pkg), requirements())).toMatchObject({ success: true });
  });

  it.each([
    [
      'the hub is down',
      (): void => {
        hub.down = true;
      },
      R.ledger,
    ],
    [
      'the hub does not know the AA (lagging)',
      (): void => {
        hub.definitions.delete(AA);
      },
      R.channel,
    ],
  ])(
    'fresh process, %s: a held voucher is not refused, a new one is',
    async (_name, breakHub, newReason) => {
      const pkg = await stuck();
      breakHub();
      expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
        isValid: true,
        payer: client,
      });
      const res = await facilitator().settle(payload(pkg), requirements());
      expect(res).toMatchObject({
        success: false,
        errorReason: 'settlement_pending',
        payer: client,
      });
      expect(res.transaction).not.toBe('');
      const req2 = requirements('e1'.repeat(32));
      expect(
        await facilitator().verify(payload(voucher(200, { binding: 'e1'.repeat(32) }), req2), req2),
      ).toMatchObject({ isValid: false, invalidReason: newReason });
    },
  );

  it.each([
    ['an empty answer', {}],
    ['a lower period (lagging hub)', { period: 1, balanceB: 1_000 }],
    ['a non-numeric period', { period: '3', balanceB: 1_000 }],
  ])('hub shows %s: never cancels, treated as ledger unavailable', async (_name, vars) => {
    hub.aaVars.set(AA, { period: 2, balanceB: 1_000 });
    gateway.ack = 'timeout';
    const pkg = voucher(100, { period: 2 });
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      errorReason: 'settlement_pending',
    });
    gateway.ack = 'acked';
    hub.aaVars.set(AA, vars);
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
    });
    const res = await facilitator().settle(payload(pkg), requirements());
    expect(res).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(gateway.delivered).toHaveLength(1);
    expect((await store.commitmentByHash(gateway.delivered[0]!.packageHash))?.state).toBe(
      'pending',
    );
  });

  it('verify cancels under the channel lock: it waits for an in-flight settle', async () => {
    const pkg = await stuck();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deliver = gateway.deliver.bind(gateway);
    gateway.deliver = async (c) => {
      await gate;
      return deliver(c);
    };
    const f = facilitator();
    const settling = f.settle(payload(pkg), requirements());
    await new Promise((r) => setTimeout(r, 10)); // settle is now waiting for the ack
    hub.aaVars.set(AA, { period: 2, balanceB: 1_000 });
    let verified = false;
    const verifying = f.verify(payload(pkg), requirements()).then((v) => {
      verified = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(verified).toBe(false); // queued behind the settle, did not cancel meanwhile
    release();
    expect(await settling).toMatchObject({ success: true });
    // The ack won: verify sees a committed entry, not a cancellation.
    expect(await verifying).toMatchObject({ isValid: true });
    expect((await store.commitmentByHash(gateway.delivered[0]!.packageHash))?.state).toBe(
      'committed',
    );
  });

  it('a committed voucher is replayed as success even after its period closed', async () => {
    const pkg = voucher(100);
    expect((await facilitator().settle(payload(pkg), requirements())).success).toBe(true);
    hub.aaVars.set(AA, { period: 2, balanceB: 0, close_initiated_by: client });
    expect((await facilitator().settle(payload(pkg), requirements())).success).toBe(true);
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
    });
  });
});

describe('upgrade: entries stored under older rules', () => {
  /** A validly signed voucher in the pre-v1.2 loose profile (extra `timestamp`). */
  const loose = (aa = AA) => {
    const pkg: any = structuredClone(voucher(100, { aa }));
    pkg.timestamp = NOW;
    delete pkg.authors[0].authentifiers;
    pkg.authors[0].authentifiers = { r: signHash(getSignedPackageHashToSign(pkg), clientKey) };
    return pkg;
  };
  /** Stores `pkg` as the old facilitator did (pending, optionally committed). */
  const storeOld = async (pkg: any, aa: string, commit: boolean) => {
    const appended = await store.appendPending({
      channelKey: networkKey(getNetwork(NET), 'aa', aa),
      network: NET,
      aa,
      payTo: seller,
      payer: client,
      asset: 'base',
      period: 1,
      amountSpent: 100n,
      paymentAmount: 100n,
      binding: 'f0'.repeat(32),
      packageHash: packageHashOf(pkg),
      packageJson: JSON.stringify(pkg),
    });
    if (!appended.ok) throw new Error('append failed');
    const owner = { payTo: seller, network: NET, packageHash: packageHashOf(pkg) };
    if (commit) await store.commit(appended.commitment.seq, owner);
  };

  it('a committed loose-profile voucher is replayed as success (verify and settle)', async () => {
    const pkg = loose();
    await storeOld(pkg, AA, true);
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
      payer: client,
    });
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: true,
      payer: client,
      extra: { chargedAmount: '100', channelState: { chargedCumulativeAmount: '100' } },
    });
    expect(gateway.delivered).toHaveLength(0);
  });

  it('a committed voucher of a legacy v1.1 channel is replayed as success', async () => {
    const legacyBase = LEGACY_CHANNEL_BASE_AAS[0]!;
    const legacyAa = channelAddress(params, legacyBase);
    hub.definitions.set(legacyAa, channelDefinition(params, legacyBase));
    const pkg = voucher(100, { aa: legacyAa });
    await storeOld(pkg, legacyAa, true);
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: true,
    });
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
    });
  });

  it('the replay still requires the same operation; NEW loose vouchers stay refused', async () => {
    const pkg = loose();
    await storeOld(pkg, AA, true);
    const other = requirements('e1'.repeat(32));
    expect(await facilitator().settle(payload(pkg, other), other)).toMatchObject({
      success: false,
    });
    const cheaper = requirements(undefined, '50');
    expect(await facilitator().verify(payload(pkg, cheaper), cheaper)).toMatchObject({
      isValid: false,
    });
    const fresh: any = structuredClone(voucher(200));
    fresh.timestamp = NOW;
    delete fresh.authors[0].authentifiers;
    fresh.authors[0].authentifiers = { r: signHash(getSignedPackageHashToSign(fresh), clientKey) };
    expect(await facilitator().settle(payload(fresh), requirements())).toMatchObject({
      success: false,
      errorReason: R.signature,
    });
  });

  it('a PENDING loose-profile voucher is refused and cancelled (drain pending vouchers before upgrading)', async () => {
    const pkg = loose();
    await storeOld(pkg, AA, false);
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.signature,
    });
    expect((await store.commitmentMeta(packageHashOf(pkg)))?.state).toBe('cancelled');
  });
});

describe('voucher package profile: only what the channel AA accepts', () => {
  /** A validly re-signed voucher whose shape the AA's is_valid_signed_package rejects. */
  const resigned = (mutate: (p: any) => void) => {
    const pkg: any = structuredClone(voucher(100));
    mutate(pkg);
    delete pkg.authors[0].authentifiers;
    pkg.authors[0].authentifiers = { r: signHash(getSignedPackageHashToSign(pkg), clientKey) };
    return pkg;
  };

  it.each([
    ['a timestamp field', (p: any) => (p.timestamp = NOW)],
    ['a last_ball_unit', (p: any) => (p.last_ball_unit = 'A'.repeat(43) + '=')],
    ['version 1.0t', (p: any) => (p.version = '1.0t')],
  ])('refuses a validly signed voucher with %s (verify and settle)', async (_name, mutate) => {
    const pkg = resigned(mutate);
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.signature,
    });
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: false,
      errorReason: R.signature,
    });
    expect(gateway.delivered).toHaveLength(0);
  });

  it('the re-signing helper itself yields an accepted voucher when nothing is changed', async () => {
    const pkg = resigned(() => {});
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: true,
    });
  });
});

describe('channel base AA v1.2', () => {
  it('advertises the v1.2 base AA', () => {
    expect(CHANNEL_BASE_AA).toBe('7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR');
    expect(facilitator().getExtra(NET)).toMatchObject({ baseAa: CHANNEL_BASE_AA });
  });

  it('refuses a voucher for a channel on the legacy v1.1 base AA', async () => {
    const legacyBase = LEGACY_CHANNEL_BASE_AAS[0]!;
    const legacyAa = channelAddress(params, legacyBase);
    hub.definitions.set(legacyAa, channelDefinition(params, legacyBase));
    hub.aaVars.set(legacyAa, { period: 1, balanceB: 1_000 });
    const pkg = voucher(100, { aa: legacyAa });
    expect(await facilitator().verify(payload(pkg), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.channel,
    });
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: false,
      errorReason: R.channel,
    });
  });

  it('refuses requirements that name the legacy base AA', () => {
    const req = requirements();
    const legacy = { ...req, extra: { ...req.extra, baseAa: LEGACY_CHANNEL_BASE_AAS[0] } };
    expect(parseBatchRequirements(legacy)).toMatchObject({
      ok: false,
      reason: 'invalid_payment_requirements',
    });
  });
});

describe('amounts within Oscript precision', () => {
  it('refuses a price above 1e15', () => {
    expect(parseBatchRequirements(requirements(undefined, '1000000000000001'))).toMatchObject({
      ok: false,
      reason: 'invalid_payment_requirements',
    });
    expect(parseBatchRequirements(requirements(undefined, String(MAX_VOUCHER_AMOUNT))).ok).toBe(
      true,
    );
  });

  it('refuses a voucher with amount_spent above 1e15', async () => {
    const res = await facilitator().verify(
      payload(voucher(MAX_VOUCHER_AMOUNT + 1)),
      requirements(),
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: R.payload });
  });

  it.each([
    ['unsafe', 2 ** 53 + 2],
    ['fractional', 1000.5],
    ['a string', '1000'],
  ])('refuses when balanceB from the hub is %s', async (_name, balanceB) => {
    hub.aaVars.set(AA, { period: 1, balanceB });
    expect(await facilitator().verify(payload(voucher(100)), requirements())).toMatchObject({
      isValid: false,
      invalidReason: R.ledger,
    });
  });
});

describe('a stored pending voucher refused definitely is cancelled', () => {
  const strict = (events?: { kind: string; data?: Record<string, unknown> }[]) =>
    new BatchObyteFacilitator({
      clients: new Map([[NET, hub.asClient()]]),
      store,
      gateway,
      logger: silent,
      allowedAssets: new Map([[NET, new Set(['base'])]]),
      minChannelTimeoutSeconds: 86_400, // the operator raised the floor above the channel's 7200
      hubTimeoutMs: 100,
      now: () => NOW,
      ...(events ? { events: async (e) => void events.push(e) } : {}),
    });
  const stuck = async () => {
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      errorReason: 'settlement_pending',
    });
    gateway.ack = 'acked';
    return pkg;
  };
  const channelKey = () => networkKey(getNetwork(NET), 'aa', AA);

  it.each(['settle', 'verify'] as const)(
    '%s: refused, the entry is cancelled and the channel freed (never re-delivered)',
    async (op) => {
      const events: { kind: string; data?: Record<string, unknown> }[] = [];
      const pkg = await stuck();
      const f = strict(events);
      const res =
        op === 'settle'
          ? await f.settle(payload(pkg), requirements())
          : await f.verify(payload(pkg), requirements());
      expect(res).toMatchObject(
        op === 'settle'
          ? { success: false, errorReason: R.timeout }
          : { isValid: false, invalidReason: R.timeout },
      );
      expect((await store.commitmentMeta(packageHashOf(pkg)))?.state).toBe('cancelled');
      expect(await store.channel(channelKey())).toMatchObject({ pendingSeq: null });
      expect(await store.pending(seller)).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'voucher_cancelled',
          data: expect.objectContaining({ reason: R.timeout }),
        }),
      );
      expect(gateway.delivered).toHaveLength(1);
    },
  );

  it('if the ack won the race, the answer is success', async () => {
    const pkg = await stuck();
    const cancel = store.cancel.bind(store);
    store.cancel = async (seq, owner) => {
      await store.commit(seq, owner); // the watcher's ack lands first
      return cancel(seq, owner);
    };
    expect(await strict().settle(payload(pkg), requirements())).toMatchObject({
      success: true,
      extra: { chargedAmount: '100' },
    });
    expect((await store.commitmentMeta(packageHashOf(pkg)))?.state).toBe('committed');
  });
});

describe('networks', () => {
  it('only the CAIP-2 id: a v1 alias is refused by verify and settle alike', async () => {
    const pkg = voucher(100);
    expect((await facilitator().settle(payload(pkg), requirements())).success).toBe(true);
    const alias = { ...requirements(), network: 'obyte-testnet' } as unknown as PaymentRequirements;
    expect(parseBatchRequirements(alias)).toMatchObject({ ok: false, reason: 'invalid_network' });
    expect(await facilitator().verify(payload(pkg, alias), alias)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_network',
    });
    expect(await facilitator().settle(payload(pkg, alias), alias)).toMatchObject({
      success: false,
      errorReason: 'invalid_network',
    });
  });

  it('refuses a channel on a network where the base AA is not deployed (mainnet)', async () => {
    const LIVE = 'obyte:livenet';
    const f = new BatchObyteFacilitator({
      clients: new Map([[LIVE, hub.asClient()]]),
      store,
      gateway,
      logger: silent,
      allowedAssets: new Map([[LIVE, new Set(['base'])]]),
      minChannelTimeoutSeconds: 3600,
      now: () => NOW,
    });
    const req = { ...requirements(), network: LIVE } as PaymentRequirements;
    expect(await f.verify(payload(voucher(100, { testnet: false }), req), req)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_network',
    });
  });
});

describe('construction', () => {
  it('refuses a channel timeout floor below 3600 s', () => {
    const make = (minChannelTimeoutSeconds: number) =>
      new BatchObyteFacilitator({
        clients: new Map(),
        store,
        gateway,
        logger: silent,
        allowedAssets: new Map(),
        minChannelTimeoutSeconds,
      });
    expect(() => make(3599)).toThrow(/at least 3600/);
    expect(() => make(Number.NaN)).toThrow(/at least 3600/);
    expect(() => make(3600)).not.toThrow();
  });
});

describe('the package body is read only to deliver it', () => {
  it('verify, settle and a pending retry never decrypt a stored package', async () => {
    const reads: string[] = [];
    const byHash = store.commitmentByHash.bind(store);
    const bySeq = store.commitment.bind(store);
    store.commitmentByHash = async (h) => (reads.push('by_hash'), byHash(h));
    store.commitment = async (s) => (reads.push('by_seq'), bySeq(s));
    gateway.ack = 'timeout';
    const pkg = voucher(100);
    await facilitator().verify(payload(pkg), requirements());
    await facilitator().settle(payload(pkg), requirements());
    gateway.ack = 'acked';
    await facilitator().verify(payload(pkg), requirements());
    expect(await facilitator().settle(payload(pkg), requirements())).toMatchObject({
      success: true,
    });
    expect(reads).toEqual([]);
    // the retry delivered the very package that was stored
    expect(gateway.delivered[1]?.packageJson).toBe(gateway.delivered[0]?.packageJson);
  });
});
