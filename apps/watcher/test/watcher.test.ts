import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import obyte from 'obyte';
import { OBYTE_NETWORKS, channelAddress, channelDefinition } from '@obbyx/obyte';
import { createLogger } from '@obbyx/obyte/logger';
import { SqliteBatchStore, SqliteSettlementStore, canonical } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WsWatcherGateway } from '../../facilitator/src/watcher/gateway.js';
import {
  HASH_A,
  HASH_B,
  HASH_C,
  addressOf,
  testKey,
} from '../../../packages/obyte/test/helpers.js';
import { FakeHub } from '../../../packages/x402-obyte/test/fake-hub.js';
import { WatcherStore, openWatcherDatabase } from '../src/storage/store.js';
import { Defender } from '../src/chain/defender.js';
import { FacilitatorLink } from '../src/facilitator/link.js';

const NET = OBYTE_NETWORKS.testnet;
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const clientKey = testKey('client');
const client = addressOf(clientKey);
const params = { addressA: seller, addressB: client, asset: 'base', salt: 'w1', timeout: 3600 };
const AA = channelAddress(params);
const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });

function migratedFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'obbyx-watcher-')), 'watcher.db');
  const db = new DatabaseSync(file);
  const dir = new URL('../prisma/migrations/', import.meta.url).pathname;
  for (const m of readdirSync(dir)
    .filter((d) => !d.endsWith('.toml'))
    .sort()) {
    db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  }
  db.close();
  return file;
}

/** obyte.js client answered by the FakeHub, composing units offline for the seller. */
function offlineClient(hub: FakeHub): obyte.Client {
  const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  c.close();
  const any = c as unknown as { cachedWitnesses: string[]; api: Record<string, unknown> };
  Object.assign(any.api, hub.client.api);
  any.cachedWitnesses = ['W'.repeat(32)];
  any.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
    parent_units: [HASH_A],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1,
    timestamp: Math.floor(Date.now() / 1000),
    tps_fee: 10,
  });
  any.api['getDefinitionForAddress'] = async () => ({ definition_chash: seller, is_stable: true });
  any.api['pickDivisibleCoinsForAmount'] = async () => ({
    inputs_with_proofs: [{ input: { unit: HASH_A, message_index: 0, output_index: 0 } }],
    total_amount: 1_000_000,
  });
  return c;
}

const voucherPkg = (amountSpent: number, key = clientKey) =>
  obyte.utils.signMessage(
    {
      aa_address: AA,
      period: 1,
      amount_spent: amountSpent,
      payment_amount: 100,
      binding: 'f0'.repeat(32),
    },
    { privateKey: key, testnet: true },
  ) as unknown as Record<string, unknown>;

let http: FastifyInstance;
let gateway: WsWatcherGateway;
let facilitatorStore: SqliteBatchStore;
let hub: FakeHub;
let store: WatcherStore;
let link: FacilitatorLink;
let posted: Record<string, unknown>[];

const until = async (cond: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function append(pkg: Record<string, unknown>, amountSpent: bigint, hash: string) {
  const res = await facilitatorStore.appendPending({
    channelKey: `${NET.caip2}:aa:${AA}`,
    network: NET.caip2,
    aa: AA,
    payTo: seller,
    payer: client,
    asset: 'base',
    period: 1,
    amountSpent,
    paymentAmount: 100n,
    binding: 'f0'.repeat(32),
    packageHash: hash,
    packageJson: canonical(pkg),
  });
  if (!res.ok) throw new Error(`append failed: ${res.reason}`);
  return res.commitment;
}

beforeEach(async () => {
  hub = new FakeHub();
  hub.definitions.set(AA, channelDefinition(params));
  hub.aaVars.set(AA, { period: 1, balanceB: 10_000 });
  posted = [];
  hub.client.api.postJoint = async ({ unit }: { unit: Record<string, unknown> }) => {
    posted.push(unit);
    return 'accepted';
  };
  facilitatorStore = new SqliteBatchStore(new SqliteSettlementStore(':memory:').database);
  http = Fastify();
  gateway = new WsWatcherGateway({
    store: facilitatorStore,
    logger: silent,
    networks: [NET.caip2],
    minBytes: 0n,
    heartbeatTimeoutMs: 60_000,
  });
  gateway.attach(http.server);
  const base = (await http.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
  store = new WatcherStore(await openWatcherDatabase(migratedFile()));
  link = new FacilitatorLink({
    url: `${base}/watcher`,
    network: NET,
    seller,
    privateKey: sellerKey,
    client: offlineClient(hub),
    store,
    logger: silent,
    bytesBalance: async () => 1_000_000n,
  });
});

afterEach(async () => {
  link.stop();
  await gateway.close();
  await http.close();
  await store.close();
});

const dataOf = (unit: Record<string, unknown>) =>
  (unit['messages'] as { app: string; payload: Record<string, unknown> }[]).find(
    (m) => m.app === 'data',
  )!.payload;

describe('seller watcher', () => {
  it('stores a valid voucher durably, then acks → the facilitator commits it', async () => {
    const pkg = voucherPkg(100);
    const c = await append(pkg, 100n, 'v1');
    link.start();
    await until(async () => (await facilitatorStore.commitment(c.seq))?.state === 'committed');
    expect(await store.cursor()).toBe(c.seq);
    expect(await store.best(AA, 1)).toMatchObject({
      amountSpent: 100n,
      packageJson: canonical(pkg),
    });
    expect(await store.channel(AA)).toMatchObject({ payer: client, timeout: 3600 });
  });

  it("logs the same proofId as the facilitator's voucher hash (end-to-end correlation)", async () => {
    const lines: Record<string, unknown>[] = [];
    const capture = createLogger({
      level: 'info',
      destination: new Writable({
        write: (c: Buffer, _e, cb) => {
          for (const l of c.toString().split('\n').filter(Boolean))
            lines.push(JSON.parse(l) as Record<string, unknown>);
          cb();
        },
      }),
    });
    link.stop();
    const base = (link as unknown as { options: { url: string } }).options.url;
    link = new FacilitatorLink({
      url: base,
      network: NET,
      seller,
      privateKey: sellerKey,
      client: offlineClient(hub),
      store,
      logger: capture,
      bytesBalance: async () => 1_000_000n,
    });
    const c = await append(voucherPkg(100), 100n, 'placeholder-hash');
    link.start();
    await until(async () => (await facilitatorStore.commitment(c.seq))?.state === 'committed');
    const acked = lines.find((l) => l['msg'] === 'voucher stored and acked');
    const { createHash } = await import('node:crypto');
    expect(acked?.['proofId']).toBe(createHash('sha256').update(c.packageJson).digest('hex'));
  });

  it('a forged voucher is never acked (stays pending, not stored)', async () => {
    const c = await append(voucherPkg(100, testKey('mallory')), 100n, 'v2');
    link.start();
    await until(() => link.connected);
    await new Promise((r) => setTimeout(r, 100));
    expect((await facilitatorStore.commitment(c.seq))?.state).toBe('pending');
    expect(await store.cursor()).toBe(0);
  });

  it('answers a dishonest client close with a fraud proof carrying our best voucher, once', async () => {
    const pkg = voucherPkg(100);
    const c = await append(pkg, 100n, 'v3');
    link.start();
    await until(async () => (await facilitatorStore.commitment(c.seq))?.state === 'committed');

    hub.aaVars.set(AA, {
      period: 1,
      balanceB: 10_000,
      close_initiated_by: 'B',
      close_start_ts: 1,
      spentByB: 0,
    });
    const defender = new Defender({
      client: offlineClient(hub),
      store,
      logger: silent,
      privateKey: sellerKey,
      testnet: true,
      policy: { closeAtAmount: 1_000_000n, closeAfterSeconds: 86_400 },
    });
    await defender.tick();
    await defender.tick();
    expect(posted).toHaveLength(1);
    const unit = posted[0]!;
    expect(dataOf(unit)).toEqual({ fraud_proof: 1, sentByPeer: JSON.parse(canonical(pkg)) });
    const payment = (
      unit['messages'] as {
        app: string;
        payload: { outputs: { address: string; amount: number }[] };
      }[]
    ).find((m) => m.app === 'payment')!;
    expect(payment.payload.outputs).toContainEqual({ address: AA, amount: 10_000 });
    expect((unit['authors'] as { address: string }[])[0]!.address).toBe(seller);
  });

  it('closes the channel with the best voucher when the policy says so', async () => {
    await append(voucherPkg(100), 100n, 'v4');
    link.start();
    await until(async () => (await store.cursor()) > 0);
    const defender = new Defender({
      client: offlineClient(hub),
      store,
      logger: silent,
      privateKey: sellerKey,
      testnet: true,
      policy: { closeAtAmount: 100n, closeAfterSeconds: 86_400 },
    });
    await defender.tick();
    expect(posted).toHaveLength(1);
    expect(dataOf(posted[0]!)).toMatchObject({ close: 1, period: 1, transferredFromMe: 0 });
  });
});

describe('the watcher survives bad input', () => {
  it('a non-JSON message, an unknown message and a failing store never throw', async () => {
    const handle = (
      link as unknown as { handle(ws: unknown, raw: string): Promise<void> }
    ).handle.bind(link);
    const ws = { send: () => undefined, readyState: 1 };
    await expect(handle(ws, '{not json')).resolves.toBeUndefined();
    await expect(handle(ws, JSON.stringify({ type: 'nope' }))).resolves.toBeUndefined();
    const broken = new FacilitatorLink({
      url: 'ws://127.0.0.1:9/watcher', // never started
      network: NET,
      seller,
      privateKey: sellerKey,
      client: offlineClient(hub),
      store: {
        ...store,
        cursor: async () => Promise.reject(new Error('db gone')),
      } as unknown as typeof store,
      logger: silent,
      bytesBalance: async () => 1_000_000n,
    });
    const h2 = (
      broken as unknown as { handle(ws: unknown, raw: string): Promise<void> }
    ).handle.bind(broken);
    await expect(
      h2(ws, JSON.stringify({ type: 'challenge', challenge: 'c'.repeat(32) })),
    ).resolves.toBeUndefined();
  });
});
