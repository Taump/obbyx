import { Writable } from 'node:stream';
import obyte from 'obyte';
import { getSignedPackageHashToSign, sign as signHash } from 'obyte/lib/internal.js';
import {
  type ChannelParams,
  LEGACY_CHANNEL_BASE_AAS,
  OBYTE_NETWORKS,
  channelAddress,
  channelDefinition,
  verifySignedPackage,
} from '@obbyx/obyte';
import { type Logger, createLogger } from '@obbyx/obyte/logger';
import { canonical } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HASH_A,
  HASH_B,
  HASH_C,
  addressOf,
  migratedSqliteFile,
  silentLogger,
  testKey,
} from '../../../packages/obyte/test/helpers.js';
import { FakeHub } from '../../../packages/x402-obyte/test/fake-hub.js';
import { WatcherStore, openWatcherDatabase } from '../src/storage/store.js';
import {
  Defender,
  type DefenderOptions,
  LOST_AFTER_SECONDS,
  MAX_ATTEMPTS,
  MAX_RESEND_SECONDS,
  MIN_RESEND_SECONDS,
  bounceBackoff,
} from '../src/chain/defender.js';
import { FacilitatorLink, type FacilitatorLinkOptions } from '../src/facilitator/link.js';

/*
 * Safety invariants W1-W7 of the seller watcher. The link is driven through
 * its message handler with a fake socket, the defender against a FakeHub with
 * a controllable clock (shared with the store).
 */

const NET = OBYTE_NETWORKS.testnet;
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const clientKey = testKey('client');
const client = addressOf(clientKey);
const BINDING = 'f0'.repeat(32);
const params: ChannelParams = {
  addressA: seller,
  addressB: client,
  asset: 'base',
  salt: 'sec',
  timeout: 3600,
};
const AA = channelAddress(params);
const LEGACY_BASE = LEGACY_CHANNEL_BASE_AAS[0]!;
const legacyParams: ChannelParams = { ...params, salt: 'legacy' };
const LEGACY_AA = channelAddress(legacyParams, LEGACY_BASE);
const silent = silentLogger();

let hub: FakeHub;
let store: WatcherStore;
let db: Awaited<ReturnType<typeof openWatcherDatabase>>;
let clock: number;
let posted: Record<string, unknown>[];
/** AA responses by trigger unit (for `getAaResponseChain`). */
let responses: Map<string, Record<string, unknown>[]>;
let lastStableTs: number;
let links: FacilitatorLink[];
let seqCounter: number;

/** obyte.js client answered by the FakeHub, composing units offline for the seller. */
function offlineClient(): obyte.Client {
  const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  c.onError(() => undefined); // never connects; keep the test output quiet
  c.close();
  const any = c as unknown as { cachedWitnesses: string[]; api: Record<string, unknown> };
  Object.assign(any.api, hub.client.api);
  any.cachedWitnesses = ['W'.repeat(32)];
  any.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
    parent_units: [HASH_A],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1,
    timestamp: clock,
    tps_fee: 10,
  });
  any.api['getDefinitionForAddress'] = async () => ({ definition_chash: seller, is_stable: true });
  any.api['pickDivisibleCoinsForAmount'] = async () => ({
    inputs_with_proofs: [{ input: { unit: HASH_A, message_index: 0, output_index: 0 } }],
    total_amount: 1_000_000,
  });
  any.api['getAaResponseChain'] = async ({ trigger_unit }: { trigger_unit: string }) =>
    responses.get(trigger_unit) ?? [];
  any.api['getLastStableUnitProps'] = async () => ({
    unit: HASH_C,
    main_chain_index: 1,
    timestamp: lastStableTs,
  });
  return c;
}

const pkgFor = (amount: number, aa = AA, period = 1, key = clientKey) =>
  obyte.utils.signMessage(
    { aa_address: aa, period, amount_spent: amount, payment_amount: 100, binding: BINDING },
    { privateKey: key, testnet: true },
  ) as unknown as Record<string, unknown>;

/** A facilitator `commitment` message for a package (envelope consistent with it). */
const commitment = (seq: number, pkg: Record<string, unknown>) => {
  const m = pkg['signed_message'] as Record<string, unknown>;
  return JSON.stringify({
    type: 'commitment',
    seq,
    network: NET.caip2,
    aa: m['aa_address'],
    period: m['period'],
    amountSpent: String(m['amount_spent']),
    paymentAmount: '100',
    binding: BINDING,
    signedPackage: pkg,
    state: 'pending',
  });
};

/** Stores a voucher directly (as an earlier ack would have). */
const storeVoucher = (amount: number, aa = AA, timeout = params.timeout) => {
  seqCounter += 1;
  return store.saveVoucher({
    seq: seqCounter,
    network: NET.caip2,
    aa,
    period: 1,
    amountSpent: BigInt(amount),
    paymentAmount: 100n,
    binding: BINDING,
    packageJson: canonical(pkgFor(amount, aa)),
    channel: { aa, network: NET.caip2, payer: client, asset: 'base', timeout },
  });
};

interface Driven {
  link: FacilitatorLink;
  sent: string[];
  ws: { send: (d: string) => number; readyState: number; close: () => void };
  handle: (raw: string) => Promise<void>;
  newChannels: string[];
  closingVouchers: string[];
}

/** A link never connected, fed raw facilitator messages through a fake socket. */
function drive(extra: Partial<FacilitatorLinkOptions> = {}): Driven {
  const newChannels: string[] = [];
  const closingVouchers: string[] = [];
  const link = new FacilitatorLink({
    url: 'ws://127.0.0.1:9/watcher',
    network: NET,
    seller,
    privateKey: sellerKey,
    client: offlineClient(),
    store,
    logger: silent,
    bytesBalance: async () => 1_000_000n,
    onNewChannel: (aa) => newChannels.push(aa),
    onClosingVoucher: (aa) => closingVouchers.push(aa),
    ...extra,
  });
  links.push(link);
  const sent: string[] = [];
  const ws = { send: (d: string) => sent.push(d), readyState: 1, close: () => undefined };
  const h = (link as unknown as { handle(ws: unknown, raw: string): Promise<void> }).handle.bind(
    link,
  );
  return { link, sent, ws, handle: (raw) => h(ws, raw), newChannels, closingVouchers };
}

/** `ack:<seq>` or `nack:<seq>:<signed reason>` for every receipt sent. */
const answers = (sent: string[]) =>
  sent
    .map((d) => JSON.parse(d) as { type: string; seq: number; receipt?: Record<string, unknown> })
    .filter((m) => m.type === 'ack' || m.type === 'nack')
    .map((m) => {
      const reason = (m.receipt?.['signed_message'] as { reason?: string } | undefined)?.reason;
      return m.type === 'nack' ? `nack:${m.seq}:${reason}` : `ack:${m.seq}`;
    });

function makeDefender(extra: Partial<DefenderOptions> = {}): Defender {
  return new Defender({
    client: offlineClient(),
    store,
    logger: silent,
    privateKey: sellerKey,
    testnet: true,
    policy: { closeAtAmount: 1_000_000n, closeAfterSeconds: 86_400 },
    now: () => clock,
    ...extra,
  });
}

const dataOf = (unit: Record<string, unknown>) =>
  (unit['messages'] as { app: string; payload: Record<string, unknown> }[]).find(
    (m) => m.app === 'data',
  )!.payload;

function capture(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: new Writable({
      write: (c: Buffer, _e, cb) => {
        for (const l of c.toString().split('\n').filter(Boolean))
          lines.push(JSON.parse(l) as Record<string, unknown>);
        cb();
      },
    }),
  });
  return { logger, lines };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met');
    await sleep(10);
  }
};

beforeEach(async () => {
  clock = 2_000_000_000;
  lastStableTs = clock - 30;
  seqCounter = 100;
  links = [];
  responses = new Map();
  hub = new FakeHub();
  hub.definitions.set(AA, channelDefinition(params));
  hub.aaVars.set(AA, { period: 1, balanceB: 10_000 });
  posted = [];
  hub.client.api.postJoint = async ({ unit }: { unit: Record<string, unknown> }) => {
    posted.push(unit);
    hub.joints.set(String(unit['unit']), unit);
    return 'accepted';
  };
  db = await openWatcherDatabase(
    migratedSqliteFile(new URL('../prisma/migrations/', import.meta.url), 'watcher.db'),
  );
  store = new WatcherStore(db, () => clock);
});

afterEach(async () => {
  for (const l of links) l.stop();
  await store.close();
});

/** A validly signed package the AA rejects (old loose profile), e.g. with a `timestamp` key. */
const resigned = (mutate: (p: Record<string, unknown>) => void, amount = 100) => {
  const pkg = structuredClone(pkgFor(amount)) as Record<string, unknown> & {
    authors: Record<string, unknown>[];
  };
  mutate(pkg);
  delete pkg.authors[0]!['authentifiers'];
  pkg.authors[0]!['authentifiers'] = { r: signHash(getSignedPackageHashToSign(pkg), clientKey) };
  return pkg;
};
const loosePkg = (amount: number) => resigned((p) => (p['timestamp'] = clock), amount);

/** Stores a package as a watcher before the AA-profile check did (`verified` null). */
const storeLegacy = async (amount: number, pkg: Record<string, unknown>) => {
  seqCounter += 1;
  const seq = seqCounter;
  await store.saveVoucher({
    seq,
    network: NET.caip2,
    aa: AA,
    period: 1,
    amountSpent: BigInt(amount),
    paymentAmount: 100n,
    binding: BINDING,
    packageJson: canonical(pkg),
    channel: { aa: AA, network: NET.caip2, payer: client, asset: 'base', timeout: 3600 },
  });
  await db.voucher.update({ where: { seq }, data: { verified: null } });
};

const clientClose = (spentByB: number, startedAgo = 10, aa = AA) =>
  hub.aaVars.set(aa, {
    period: 1,
    balanceB: 10_000,
    close_initiated_by: 'B',
    close_start_ts: clock - startedAgo,
    spentByB,
  });

/** Makes the AA bounce every unit posted so far with `error`. */
const bounceAll = (error = 'the peer did not lie') => {
  for (const u of posted) {
    const unit = String(u['unit']);
    responses.set(unit, [{ aa_address: AA, trigger_unit: unit, bounced: 1, response: { error } }]);
  }
};

const alerts = (lines: Record<string, unknown>[], re: RegExp) =>
  lines.filter((l) => typeof l['msg'] === 'string' && re.test(l['msg'])).length;

/** Wraps the defender's compose (e.g. to slow it down or make it hang). */
const wrapCompose = (
  defender: Defender,
  wrap: (compose: () => Promise<unknown>, call: number) => unknown,
) => {
  const c = (defender as unknown as { options: { client: obyte.Client } }).options.client;
  const compose = c.compose.message.bind(c.compose);
  let calls = 0;
  c.compose.message = ((...args: Parameters<typeof compose>) =>
    wrap(() => compose(...args), (calls += 1))) as typeof c.compose.message;
};

describe('W1. vouchers pass the strict AA profile; only v1.2 channels are new', () => {
  it.each([
    ['a timestamp field', (p: Record<string, unknown>) => (p['timestamp'] = clock)],
    ['a last_ball_unit', (p: Record<string, unknown>) => (p['last_ball_unit'] = HASH_C)],
    ['version 1.0t', (p: Record<string, unknown>) => (p['version'] = '1.0t')],
  ])('nacks a validly signed voucher with %s (useless on-chain)', async (_n, mutate) => {
    const pkg = resigned(mutate);
    expect(verifySignedPackage(pkg, { network: NET }).ok).toBe(true); // the loose profile accepts it
    const { sent, handle, newChannels } = drive();
    await handle(commitment(1, pkg));
    expect(answers(sent)).toEqual([expect.stringMatching(/^nack:1:bad signature/)]);
    expect(await store.cursor()).toBe(0);
    expect(newChannels).toEqual([]); // an invalid voucher does not start a watch
  });

  it('acks vouchers signed as obyte.js does; watches an AA only once one validated', async () => {
    const d = drive();
    await d.handle(commitment(1, pkgFor(100, AA, 1, testKey('mallory'))));
    expect(d.newChannels).toEqual([]);
    await d.handle(commitment(2, pkgFor(100)));
    await d.handle(commitment(3, pkgFor(200)));
    expect(answers(d.sent)).toEqual([expect.stringMatching(/^nack:1:/), 'ack:2', 'ack:3']);
    expect(d.newChannels).toEqual([AA]);
  });

  it('a voucher that is not stored (nacked) does not start a watch', async () => {
    await storeVoucher(200);
    const d = drive();
    await d.handle(commitment(1, pkgFor(100)));
    expect(answers(d.sent)).toEqual(['nack:1:not_increasing']);
    expect(d.newChannels).toEqual([]);
    await d.handle(commitment(2, pkgFor(300)));
    expect(d.newChannels).toEqual([AA]);
  });

  it('a voucher for a channel on the legacy base AA is nacked and never stored', async () => {
    hub.definitions.set(LEGACY_AA, channelDefinition(legacyParams, LEGACY_BASE));
    hub.aaVars.set(LEGACY_AA, { period: 1, balanceB: 10_000 });
    const d = drive();
    await d.handle(commitment(1, pkgFor(100, LEGACY_AA)));
    expect(answers(d.sent)).toEqual([expect.stringMatching(/^nack:1:.*retired/)]);
    expect(await store.cursor()).toBe(0);
    expect(d.newChannels).toEqual([]);
  });

  it('a legacy channel already in the database is still defended (fraud proof)', async () => {
    await storeVoucher(100, LEGACY_AA); // stored before the switch
    clientClose(0, 0, LEGACY_AA);
    await makeDefender().tick();
    expect(posted).toHaveLength(1);
    const unit = posted[0]!;
    expect(dataOf(unit)).toEqual({
      fraud_proof: 1,
      sentByPeer: JSON.parse(canonical(pkgFor(100, LEGACY_AA))),
    });
    const payment = (
      unit['messages'] as { app: string; payload: { outputs: { address: string }[] } }[]
    ).find((m) => m.app === 'payment')!;
    expect(payment.payload.outputs.map((o) => o.address)).toContain(LEGACY_AA);
  });

  it('a legacy channel already in the database is still closed and confirmed', async () => {
    await storeVoucher(100, LEGACY_AA);
    hub.aaVars.set(LEGACY_AA, { period: 1, balanceB: 10_000 });
    const defender = makeDefender({
      policy: { closeAtAmount: 100n, closeAfterSeconds: 86_400 },
    });
    await defender.tick(); // announced
    clock += 60;
    await defender.tick(); // sent
    expect(posted.map(dataOf)).toEqual([
      expect.objectContaining({ close: 1, period: 1, transferredFromMe: 0 }),
    ]);
    hub.aaVars.set(LEGACY_AA, {
      period: 1,
      balanceB: 10_000,
      close_initiated_by: 'A',
      close_start_ts: clock,
      spentByB: 100,
    });
    clock += 3600;
    await defender.tick();
    expect(posted.map(dataOf).at(-1)).toEqual({ confirm: 1, period: 1 });
  });
});

describe('W2. no ack for a period that can no longer be collected', () => {
  it('nacks a voucher of a period already closed on-chain (period_closed)', async () => {
    hub.aaVars.set(AA, { period: 2, balanceB: 10_000 });
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(100)));
    expect(answers(sent)).toEqual(['nack:1:period_closed']);
    expect(await store.cursor()).toBe(0);
  });

  it('nacks a voucher once OUR close is on-chain, with no local rows at all', async () => {
    hub.aaVars.set(AA, {
      period: 1,
      balanceB: 10_000,
      close_initiated_by: 'A',
      close_start_ts: clock - 10,
      spentByB: 100,
    });
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(200)));
    expect(answers(sent)).toEqual(['nack:1:channel_settling']);
    expect(await store.cursor()).toBe(0);
  });

  it('a package already stored is acked again on re-delivery, even after its period closed', async () => {
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(100)));
    hub.aaVars.set(AA, { period: 2 });
    await store.recordAction({ aa: AA, period: 1, kind: 'confirm', unit: HASH_A, status: 'done' });
    await handle(commitment(1, pkgFor(100)));
    expect(answers(sent)).toEqual(['ack:1', 'ack:1']);
  });

  it.each([
    [
      'the hub cannot give the channel state',
      () => void (hub.client.api.getAaStateVars = () => Promise.reject(new Error('hub down'))),
      1,
    ],
    ['the voucher period is ahead of our hub', () => undefined, 2],
  ])('no answer when %s (transient)', async (_n, setup, period) => {
    setup();
    const { sent, handle } = drive({ retry: { attempts: 0 } });
    await handle(commitment(1, pkgFor(100, AA, period)));
    expect(answers(sent)).toEqual([]);
  });

  it.each([
    ['confirm', 'sent', 'nack:1:channel_settling'],
    ['confirm', 'announced', 'nack:1:channel_settling'],
    ['confirm', 'done', 'nack:1:channel_settling'],
    ['confirm', 'failed', 'ack:1'],
    ['close', 'sent', 'nack:1:channel_settling'],
    ['close', 'done', 'nack:1:channel_settling'],
    ['close', 'failed', 'ack:1'],
    // an announced seller close still takes in-flight vouchers: it reads the
    // best one in the transaction that marks it sent
    ['close', 'announced', 'ack:1'],
  ] as const)('%s row %s for the period → %s', async (kind, status, expected) => {
    await store.recordAction({ aa: AA, period: 1, kind, unit: null, status });
    await store.recordAction({ aa: AA, period: 0, kind: 'confirm', unit: null, status: 'sent' }); // another period: no effect
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(100)));
    expect(answers(sent)).toEqual([expected]);
  });

  it('a voucher known to be invalid does not make a valid one "not increasing"', async () => {
    await storeVoucher(100);
    await storeLegacy(500, loosePkg(500));
    await db.voucher.update({ where: { seq: seqCounter }, data: { verified: false } });
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(50)));
    await handle(commitment(2, pkgFor(300)));
    expect(answers(sent)).toEqual(['nack:1:not_increasing', 'ack:2']);
  });

  it('during a client close a voucher above the declared amount is acked and leads to a fraud proof, even if our close was sent', async () => {
    await storeVoucher(10);
    await store.recordAction({ aa: AA, period: 1, kind: 'close', unit: HASH_A, status: 'sent' });
    clientClose(50);
    const { sent, handle, closingVouchers } = drive();
    const pkg = pkgFor(100);
    await handle(commitment(1, pkg));
    expect(answers(sent)).toEqual(['ack:1']);
    expect(closingVouchers).toEqual([AA]); // the defender is woken up at once
    await makeDefender().defendNow(AA);
    expect(posted.map(dataOf)).toEqual([
      { fraud_proof: 1, sentByPeer: JSON.parse(canonical(pkg)) },
    ]);
  });

  it('…but not once our confirm of that close is recorded', async () => {
    await store.recordAction({ aa: AA, period: 1, kind: 'close', unit: HASH_A, status: 'sent' });
    await store.recordAction({ aa: AA, period: 1, kind: 'confirm', unit: HASH_B, status: 'sent' });
    clientClose(50);
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(100)));
    expect(answers(sent)).toEqual(['nack:1:channel_settling']);
  });

  it('one package is judged at a time: a retry and a fresh delivery never give ack-then-nack', async () => {
    let reads = 0;
    hub.client.api.getAaStateVars = async () => {
      reads += 1;
      const n = reads;
      await sleep(20);
      // the period closes right after the first judgement
      return n === 1 ? { period: 1, balanceB: 10_000 } : { period: 2, balanceB: 10_000 };
    };
    const { sent, handle } = drive();
    const c = commitment(1, pkgFor(100));
    await Promise.all([handle(c), handle(c)]);
    expect(answers(sent)).toEqual(['ack:1', 'ack:1']);
    expect(reads).toBe(1); // the second saw the stored voucher
  });

  it('transient failures are retried locally while connected, a bounded number of times', async () => {
    hub.definitions.delete(AA);
    const d = drive({ retry: { baseMs: 5, maxMs: 5, attempts: 3 } });
    (d.link as unknown as { ws: unknown }).ws = d.ws; // the "current" connection
    await d.handle(commitment(1, pkgFor(100)));
    await sleep(150);
    expect(hub.calls['getDefinition']).toBe(4); // first try + 3 retries
    expect(answers(d.sent)).toEqual([]);
    hub.definitions.set(AA, channelDefinition(params));
    await d.handle(commitment(1, pkgFor(100))); // a fresh delivery starts over
    expect(answers(d.sent)).toEqual(['ack:1']);
  });

  it('a voucher not judgeable at first is acked by a local retry; none once the connection is gone', async () => {
    hub.definitions.delete(AA);
    const d = drive({ retry: { baseMs: 10, maxMs: 20, attempts: 10 } });
    (d.link as unknown as { ws: unknown }).ws = d.ws;
    await d.handle(commitment(1, pkgFor(100)));
    expect(answers(d.sent)).toEqual([]);
    hub.definitions.set(AA, channelDefinition(params));
    await until(() => answers(d.sent).length > 0);
    expect(answers(d.sent)).toEqual(['ack:1']);

    hub.definitions.delete(AA);
    const gone = drive({ retry: { baseMs: 5, maxMs: 5, attempts: 10 } }); // its socket is not current
    const calls = hub.calls['getDefinition'] ?? 0;
    await gone.handle(commitment(2, pkgFor(300)));
    await sleep(60);
    expect(hub.calls['getDefinition']).toBe(calls + 1);
  });
});

describe('W3. the decision, its action row and the best voucher are one transaction', () => {
  const honestClose = () => clientClose(100, 1000); // past the confirm grace

  it('a voucher arriving after the confirm is recorded is refused, never acked', async () => {
    await storeVoucher(100);
    honestClose();
    await makeDefender().tick();
    expect(posted.map(dataOf)).toEqual([{ confirm: 1, period: 1 }]);
    const { sent, handle } = drive();
    await handle(commitment(1, pkgFor(200)));
    expect(answers(sent)).toEqual(['nack:1:channel_settling']);
    expect((await store.best(AA, 1))?.amountSpent).toBe(100n);
  });

  it('a voucher stored between the first look and the transaction is seen: fraud proof, not confirm', async () => {
    await storeVoucher(100);
    honestClose();
    const realBest = store.best.bind(store);
    let injected = false;
    store.best = async (aa: string, period: number) => {
      const r = await realBest(aa, period);
      if (!injected) {
        injected = true; // the facilitator's voucher lands right after the defender's first read
        expect(await storeVoucher(200)).toEqual({ kind: 'stored' });
      }
      return r;
    };
    await makeDefender().tick();
    expect(posted.map(dataOf)).toEqual([
      { fraud_proof: 1, sentByPeer: JSON.parse(canonical(pkgFor(200))) },
    ]);
    expect(await store.action(AA, 1, 'confirm')).toBeUndefined();
  });

  it('concurrent voucher writes and channel transactions are serialized (no lost write)', async () => {
    await storeVoucher(1);
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => storeVoucher(10 + i)),
      store.atomically(AA, 1, async (view) => {
        await view.record({ kind: 'confirm', unit: null, status: 'sent' });
        return (await view.best())?.amountSpent;
      }),
    ]);
    const confirmSawUpTo = results.at(-1) as bigint;
    const voucherResults = results.slice(0, -1) as { kind: string }[];
    // each voucher was either stored before the confirm (and seen by it) or refused
    const stored = voucherResults.filter((r) => r.kind === 'stored').length;
    expect(stored + voucherResults.filter((r) => r.kind === 'settling').length).toBe(20);
    expect((await store.best(AA, 1))?.amountSpent).toBe(confirmSawUpTo);
  });
});

describe('W4. re-sends: never a duplicate, bounded, and only with valid vouchers', () => {
  it('a unit the hub knows and the AA did not bounce is never re-sent; stuck → one ALERT', async () => {
    await storeVoucher(100);
    clientClose(0, 3500); // 100 s of the dispute window left
    const { logger, lines } = capture();
    const defender = makeDefender({ logger });
    await defender.tick();
    expect(posted).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) {
      clock += 30;
      await defender.tick();
    }
    expect(posted).toHaveLength(1);
    expect(alerts(lines, /ALERT: sent trigger known to the hub/)).toBe(1);
  });

  it('after a post timeout and joint not found, re-sends only after the lost-unit floor', async () => {
    await storeVoucher(100);
    clientClose(0);
    let posts = 0;
    hub.client.api.postJoint = async () => {
      posts += 1;
      return new Promise(() => undefined); // timed out: outcome unknown, never reaches the hub
    };
    const defender = makeDefender({ hubTimeoutMs: 20 });
    await defender.tick();
    expect(posts).toBe(1);
    expect(await store.action(AA, 1, 'fraud_proof')).toMatchObject({ status: 'sent', attempts: 1 });
    const sentAt = clock;
    for (const at of [1, 30, 60, LOST_AFTER_SECONDS - 1]) {
      clock = sentAt + at;
      await defender.defendNow(AA); // pushes / polls
    }
    expect(posts).toBe(1);
    clock = sentAt + LOST_AFTER_SECONDS;
    await defender.tick();
    expect(posts).toBe(2);
  });

  it('bounce backoff doubles from the floor and is capped', () => {
    expect([0, 1, 2, 3, 7, 1000].map(bounceBackoff)).toEqual([
      MIN_RESEND_SECONDS,
      MIN_RESEND_SECONDS,
      60,
      120,
      MAX_RESEND_SECONDS,
      MAX_RESEND_SECONDS,
    ]);
  });

  it('re-sends a bounced trigger with the backoff, then gives up with one ALERT', async () => {
    await storeVoucher(100);
    clientClose(0);
    const { logger, lines } = capture();
    const defender = makeDefender({ logger });
    await defender.tick();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      bounceAll();
      await defender.tick(); // the bounce is seen: the backoff runs from now
      clock += bounceBackoff(attempt) - 1;
      await defender.tick();
      expect(posted).toHaveLength(attempt);
      clock += 1;
      await defender.tick();
      expect(posted).toHaveLength(attempt + 1);
    }
    bounceAll();
    for (let i = 0; i < 20; i += 1) {
      clock += MAX_RESEND_SECONDS;
      await defender.tick();
    }
    expect(posted).toHaveLength(MAX_ATTEMPTS);
    expect((await store.action(AA, 1, 'fraud_proof'))?.attempts).toBe(MAX_ATTEMPTS);
    expect(alerts(lines, /ALERT: trigger bounced on every attempt/)).toBe(1);
  });

  it('stored vouchers not yet checked are never carried; the startup pass checks them once', async () => {
    const valid = pkgFor(100);
    await storeLegacy(100, valid);
    await storeLegacy(500, loosePkg(500));
    clientClose(50);
    expect(await store.best(AA, 1)).toBeUndefined(); // before the pass: nothing usable
    expect(await store.verifyStoredVouchers()).toEqual([
      expect.objectContaining({ aa: AA, period: 1, reason: expect.stringMatching(/AA profile/) }),
    ]);
    expect(await store.verifyStoredVouchers()).toEqual([]); // once
    await makeDefender().tick();
    expect(posted.map(dataOf)).toEqual([
      { fraud_proof: 1, sentByPeer: JSON.parse(canonical(valid)) },
    ]);
  });

  it('…and when no valid voucher beats the declared amount, the close is confirmed instead', async () => {
    await storeLegacy(500, loosePkg(500));
    await store.verifyStoredVouchers();
    clientClose(50, 1000);
    await makeDefender().tick();
    expect(posted.map(dataOf)).toEqual([{ confirm: 1, period: 1 }]);
  });

  it('"invalid signature by peer" for a voucher invalid locally falls back to the next-best at once', async () => {
    await storeVoucher(100);
    const bad = loosePkg(200); // stored as valid, but the AA profile rejects it
    await storeLegacy(200, bad);
    await db.voucher.update({ where: { seq: seqCounter }, data: { verified: true } });
    clientClose(50);
    const defender = makeDefender();
    await defender.tick();
    expect(dataOf(posted[0]!)['sentByPeer']).toEqual(JSON.parse(canonical(bad)));
    bounceAll('invalid signature by peer');
    clock += 1; // no backoff: the re-send carries another voucher
    await defender.tick();
    expect(posted).toHaveLength(2);
    expect(dataOf(posted[1]!)['sentByPeer']).toEqual(JSON.parse(canonical(pkgFor(100))));
    expect((await store.best(AA, 1))?.amountSpent).toBe(100n);
    expect((await store.action(AA, 1, 'fraud_proof'))?.voucherSeq).toBe(seqCounter - 1);
  });

  /** Stores a voucher the AA profile rejects as if it had passed (verified true). */
  const storeBadAsValid = async (amount: number) => {
    const pkg = loosePkg(amount);
    await storeLegacy(amount, pkg);
    await db.voucher.update({ where: { seq: seqCounter }, data: { verified: true } });
    return pkg;
  };

  it('a bounced close with no valid voucher left frees the channel (not "closing", vouchers acked)', async () => {
    await storeBadAsValid(2_000_000);
    const defender = makeDefender({ closeAnnounceSeconds: 0 });
    await defender.tick(); // announced
    await defender.tick(); // sent
    expect(posted.map(dataOf)).toEqual([expect.objectContaining({ close: 1 })]);
    expect(await store.closingChannels()).toEqual([AA]);
    bounceAll('invalid signature by peer');
    clock += 1;
    await defender.tick();
    expect(await store.action(AA, 1, 'close')).toMatchObject({ status: 'failed' });
    expect(await store.closingChannels()).toEqual([]);
    const d = drive();
    await d.handle(commitment(500, pkgFor(3_000_000)));
    expect(answers(d.sent)).toEqual(['ack:500']);
    clock += MIN_RESEND_SECONDS;
    await defender.tick(); // after the backoff the close starts over with the new valid voucher
    expect(await store.action(AA, 1, 'close')).toMatchObject({ status: 'announced' });
  });

  it('a trigger the hub refuses is re-sent with backoff and not counted toward the bounce cap', async () => {
    await storeVoucher(100);
    clientClose(0);
    const accept = hub.client.api.postJoint;
    let refuse = true;
    let refusals = 0;
    hub.client.api.postJoint = async (a: { unit: Record<string, unknown> }) => {
      if (!refuse) return accept(a);
      refusals += 1;
      throw 'some inputs are already spent'; // a definite hub error (a string)
    };
    const defender = makeDefender();
    for (let i = 0; i < 20; i += 1) {
      await defender.tick();
      clock += 1;
    }
    expect(refusals).toBe(1); // backoff, not every poll
    for (let i = 0; i < 10; i += 1) {
      clock += MIN_RESEND_SECONDS;
      await defender.tick();
    }
    expect(refusals).toBe(11);
    expect(await store.action(AA, 1, 'fraud_proof')).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
    refuse = false;
    clock += MIN_RESEND_SECONDS;
    await defender.tick();
    expect(posted).toHaveLength(1);
    bounceAll(); // a single bounce is re-sent, not given up
    await defender.tick();
    clock += bounceBackoff(1);
    await defender.tick();
    expect(posted).toHaveLength(2);
  });

  it('a hub error for a unit the hub knows keeps the close sent (still blocks vouchers)', async () => {
    await storeVoucher(2_000_000);
    hub.client.api.postJoint = async ({ unit }: { unit: Record<string, unknown> }) => {
      hub.joints.set(String(unit['unit']), unit);
      throw 'already handling this unit';
    };
    const defender = makeDefender({ closeAnnounceSeconds: 0 });
    await defender.tick();
    await defender.tick();
    expect(await store.action(AA, 1, 'close')).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await store.closingChannels()).toEqual([AA]);
    const d = drive();
    await d.handle(commitment(500, pkgFor(3_000_000)));
    expect(answers(d.sent)).toEqual(['nack:500:channel_settling']);
  });

  it('falling back over invalid vouchers is bounded by MAX_ATTEMPTS', async () => {
    for (let a = 100; a <= 1500; a += 100) await storeBadAsValid(a);
    clientClose(50);
    const defender = makeDefender();
    for (let i = 0; i < 30; i += 1) {
      await defender.tick();
      bounceAll('invalid signature by peer');
    }
    expect(posted).toHaveLength(MAX_ATTEMPTS);
  });

  it('a lying hub never makes us drop a locally valid voucher nor confirm a dishonest close', async () => {
    for (const a of [100, 200, 300]) await storeVoucher(a);
    clientClose(0, 1000); // past the confirm grace
    const { logger, lines } = capture();
    const defender = makeDefender({ logger });
    for (let i = 0; i < 30; i += 1) {
      await defender.tick();
      bounceAll('invalid signature by peer');
      clock += MAX_RESEND_SECONDS;
    }
    expect(posted.length).toBeGreaterThan(1);
    expect(posted.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    for (const unit of posted)
      expect(dataOf(unit)).toEqual({
        fraud_proof: 1,
        sentByPeer: JSON.parse(canonical(pkgFor(300))),
      });
    expect((await db.voucher.findMany()).map((v) => v.verified)).toEqual([true, true, true]);
    expect(alerts(lines, /passes the AA profile locally/)).toBeGreaterThan(0);
  });

  it('a bounced row without voucher_seq waits the backoff instead of re-sending at once', async () => {
    await storeVoucher(100);
    await storeVoucher(200);
    clientClose(50);
    const defender = makeDefender();
    await defender.tick();
    await db.action.updateMany({ data: { voucherSeq: null } }); // as if written before the column
    bounceAll('invalid signature by peer');
    clock += 1;
    await defender.tick();
    expect(posted).toHaveLength(1); // no immediate re-send
    clock += MIN_RESEND_SECONDS;
    await defender.tick();
    expect(posted).toHaveLength(2); // the normal backoff applies
  });
});

describe('W5. compose + post are serialized, with a compose timeout', () => {
  const two = async () => {
    const AA2 = channelAddress({ ...params, salt: 'other' });
    for (const aa of [AA, AA2]) {
      await storeVoucher(100, aa);
      clientClose(0, 0, aa);
    }
    return AA2;
  };

  it('two channels defended at once never compose concurrently', async () => {
    const AA2 = await two();
    const defender = makeDefender();
    let active = 0;
    let maxActive = 0;
    wrapCompose(defender, async (compose) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(30);
        return await compose();
      } finally {
        active -= 1;
      }
    });
    await Promise.all([defender.defendNow(AA), defender.defendNow(AA2)]);
    expect(posted).toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it('a hung compose is a definite failure and does not block other channels', async () => {
    const AA2 = await two();
    const defender = makeDefender({ composeTimeoutMs: 50 });
    wrapCompose(defender, (compose, call) =>
      call === 1 ? new Promise(() => undefined) : compose(),
    );
    await Promise.all([defender.defendNow(AA), defender.defendNow(AA2)]);
    expect(posted).toHaveLength(1);
    expect(await store.action(AA, 1, 'fraud_proof')).toMatchObject({
      status: 'failed',
      unit: null,
      attempts: 0,
    });
    expect((await store.action(AA2, 1, 'fraud_proof'))?.status).toBe('sent');
    await defender.defendNow(AA); // definite failure: re-sent after the backoff
    expect(posted).toHaveLength(1);
    clock += MIN_RESEND_SECONDS;
    await defender.defendNow(AA);
    expect(posted).toHaveLength(2);
  });
});

describe('W6. channel timeout floor, hub-lag and late-close alerts, client close is "closing"', () => {
  const alerted = (lines: Record<string, unknown>[]) =>
    lines.filter((l) => l['level'] === 'error' && String(l['msg']).startsWith('ALERT'));

  it('nacks vouchers of a channel whose dispute window is below the minimum', async () => {
    const short: ChannelParams = { ...params, salt: 'short', timeout: 600 };
    const SHORT = channelAddress(short);
    hub.definitions.set(SHORT, channelDefinition(short));
    hub.aaVars.set(SHORT, { period: 1, balanceB: 10_000 });
    const d = drive();
    await d.handle(commitment(1, pkgFor(100, SHORT)));
    expect(answers(d.sent)).toEqual(['nack:1:channel_timeout_too_short']);
    const lenient = drive({ minChannelTimeout: 600 });
    await lenient.handle(commitment(2, pkgFor(100, SHORT)));
    expect(answers(lenient.sent)).toEqual(['ack:2']);
  });

  it('alerts once per episode when the hub last stable unit lags the wall clock', async () => {
    const { logger, lines } = capture();
    const defender = makeDefender({ logger });
    await defender.tick(); // 30 s behind: fine
    expect(alerted(lines)).toEqual([]);
    lastStableTs = clock - 2000;
    await defender.tick();
    await defender.tick(); // the same lag episode: no second ALERT
    expect(alerted(lines)).toEqual([
      expect.objectContaining({ lagSeconds: 2000, msg: expect.stringMatching(/hub lags/) }),
    ]);
    lastStableTs = clock - 30;
    await defender.tick();
    expect(alerts(lines, /hub caught up/)).toBe(1);
    lastStableTs = clock - 2000;
    await defender.tick(); // a new episode
    expect(alerted(lines)).toHaveLength(2);
  });

  it.each([
    [3000, 1], // 600 s of 3600 left: ALERT, once
    [60, 0],
  ])('a client close first seen %i s after it started → %i ALERT', async (ago, expected) => {
    await storeVoucher(10);
    const { logger, lines } = capture();
    clientClose(10, ago);
    const defender = makeDefender({ logger });
    await defender.tick();
    await defender.tick();
    expect(alerted(lines)).toHaveLength(expected);
    expect(lines.filter((l) => /client (started a )?close/.test(String(l['msg'])))).toHaveLength(1);
  });

  it('a pending client close makes the channel "closing" until the period moves', async () => {
    await storeVoucher(10);
    clientClose(10, 0);
    let announced = 0;
    const defender = makeDefender({ announce: async () => void (announced += 1) });
    await defender.tick();
    expect(await store.closingChannels()).toEqual([AA]);
    expect(announced).toBe(1);
    await defender.tick(); // seen again: no second announcement
    expect(announced).toBe(1);
    hub.aaVars.set(AA, { period: 2 });
    await defender.tick();
    expect(await store.closingChannels()).toEqual([]);
    expect(announced).toBe(2);
  });

  it('a voucher above balanceB is alerted but the close is still announced', async () => {
    await storeVoucher(500);
    hub.aaVars.set(AA, { period: 1, balanceB: 100 });
    const { logger, lines } = capture();
    await makeDefender({
      logger,
      policy: { closeAtAmount: 100n, closeAfterSeconds: 86_400 },
    }).tick();
    expect(lines.some((l) => l['msg'] === 'INVARIANT ALERT')).toBe(true);
    expect(await store.action(AA, 1, 'close')).toMatchObject({ status: 'announced' });
  });

  it('a malformed channel state (non-number balanceB) skips the tick', async () => {
    await storeVoucher(500);
    hub.aaVars.set(AA, { period: 1, balanceB: 'lots' });
    await makeDefender({ policy: { closeAtAmount: 100n, closeAfterSeconds: 86_400 } }).tick();
    expect(await store.action(AA, 1, 'close')).toBeUndefined();
    expect(posted).toHaveLength(0);
  });
});

describe('W7. link housekeeping', () => {
  it('a repeated welcome does not leak a heartbeat timer', async () => {
    const d = drive({ heartbeatMs: 5 });
    const welcome = JSON.stringify({ type: 'welcome', seller, network: NET.caip2 });
    await d.handle(welcome);
    await d.handle(welcome);
    d.link.stop();
    await sleep(20);
    const after = d.sent.length;
    await sleep(40);
    expect(d.sent.length).toBe(after);
  });
});
