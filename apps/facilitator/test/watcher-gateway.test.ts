import Fastify, { type FastifyInstance } from 'fastify';
import obyte from 'obyte';
import {
  type AppendInput,
  type ServerMessage,
  SqliteBatchStore,
  SqliteSettlementStore,
  loginMessage,
} from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WsWatcherGateway } from '../src/watcher/gateway.js';
import { addressOf, testKey, silentLogger } from '../../../packages/obyte/test/helpers.js';

const NET = 'obyte:testnet';
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const silent = silentLogger();

let http: FastifyInstance;
let gateway: WsWatcherGateway;
let store: SqliteBatchStore;
let url: string;
let now: number;

const voucher = (amountSpent: bigint, hash: string, payTo = seller): AppendInput => ({
  channelKey: `${NET}:aa:${payTo}`,
  network: NET,
  aa: 'X'.repeat(32),
  payTo,
  payer: 'P'.repeat(32),
  asset: 'base',
  period: 1,
  amountSpent,
  paymentAmount: 100n,
  binding: 'b'.repeat(64),
  packageHash: hash,
  packageJson: '{"signed_message":{}}',
});

/** Minimal watcher client (the real one lives in apps/watcher). */
async function connectWatcher(opts: {
  key?: Uint8Array;
  cursor?: number;
  bytes?: string;
  network?: string;
  signNetwork?: boolean;
  autoAck?: boolean;
}) {
  const ws = new WebSocket(`${url}/watcher`);
  const received: ServerMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage;
    received.push(msg);
    if (msg.type === 'challenge') {
      const login = obyte.utils.signMessage(
        loginMessage(msg.challenge, opts.network ?? NET, Math.floor(now / 1000)),
        {
          privateKey: opts.key ?? sellerKey,
          testnet: opts.signNetwork ?? true,
        },
      );
      ws.send(
        JSON.stringify({
          type: 'hello',
          network: opts.network ?? NET,
          login,
          cursor: opts.cursor ?? 0,
          bytesBalance: opts.bytes ?? '1000000',
        }),
      );
    }
    if (msg.type === 'commitment' && opts.autoAck !== false)
      ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }));
  });
  return { ws, received, closed };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const untilAsync = async (cond: () => Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  now = Date.now();
  store = new SqliteBatchStore(new SqliteSettlementStore(':memory:').database);
  http = Fastify();
  gateway = new WsWatcherGateway({
    store,
    logger: silent,
    networks: [NET],
    minBytes: 100_000n,
    heartbeatTimeoutMs: 30_000,
    now: () => now,
  });
  gateway.attach(http.server);
  url = (await http.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
});

afterEach(async () => {
  await gateway.close();
  await http.close();
});

describe('watcher gateway', () => {
  it('logs in the seller by signature and reports health (connected, fresh, funded)', async () => {
    expect(gateway.health(seller, NET).ok).toBe(false);
    const w = await connectWatcher({});
    await until(() => w.received.some((m) => m.type === 'welcome'));
    expect(gateway.health(seller, NET)).toEqual({ ok: true });
    now += 31_000;
    expect(gateway.health(seller, NET)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/stale/),
    });
    w.ws.close();
  });

  it('a watcher without enough bytes for defensive triggers is not healthy', async () => {
    const w = await connectWatcher({ bytes: '5000' });
    await until(() => w.received.some((m) => m.type === 'welcome'));
    expect(gateway.health(seller, NET)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/bytes/),
    });
    w.ws.close();
  });

  it('rejects a login signed for another network', async () => {
    const w = await connectWatcher({ signNetwork: false });
    expect((await w.closed).code).toBe(4001);
    expect(gateway.health(seller, NET).ok).toBe(false);
  });

  it('deliver resolves only after the watcher ack; the voucher is then committed', async () => {
    const w = await connectWatcher({});
    await until(() => gateway.health(seller, NET).ok);
    const appended = await store.appendPending(voucher(100n, 'h1'));
    if (!appended.ok) throw new Error('append failed');
    expect(await gateway.deliver(appended.commitment, 1000)).toBe('acked');
    expect((await store.commitment(appended.commitment.seq))?.state).toBe('committed');
    w.ws.close();
  });

  it('no ack → timeout; nobody connected → timeout immediately', async () => {
    const appended = await store.appendPending(voucher(100n, 'h2'));
    if (!appended.ok) throw new Error('append failed');
    expect(await gateway.deliver(appended.commitment, 100)).toBe('timeout');
    const w = await connectWatcher({ autoAck: false });
    await until(() => gateway.health(seller, NET).ok);
    expect(await gateway.deliver(appended.commitment, 100)).toBe('timeout');
    expect((await store.commitment(appended.commitment.seq))?.state).toBe('pending');
    w.ws.close();
  });

  it('on reconnect the journal is replayed from the cursor and pending vouchers are reconciled', async () => {
    const a = await store.appendPending(voucher(100n, 'r1'));
    if (!a.ok) throw new Error('append failed');
    const w = await connectWatcher({ cursor: 0 });
    await untilAsync(async () => (await store.commitment(a.commitment.seq))?.state === 'committed');
    expect(
      w.received
        .filter((m) => m.type === 'commitment')
        .map((m) => m.type === 'commitment' && m.seq),
    ).toEqual([a.commitment.seq]);
    w.ws.close();
    await w.closed;

    const again = await connectWatcher({ cursor: a.commitment.seq });
    await until(() => again.received.some((m) => m.type === 'welcome'));
    await new Promise((r) => setTimeout(r, 50));
    expect(again.received.filter((m) => m.type === 'commitment')).toHaveLength(0);
    again.ws.close();
  });

  it("a watcher cannot ack (commit) another seller's voucher", async () => {
    const other = addressOf(testKey('other-seller'));
    const foreign = await store.appendPending(voucher(100n, 'f1', other));
    if (!foreign.ok) throw new Error('append failed');
    const w = await connectWatcher({});
    await until(() => w.received.some((m) => m.type === 'welcome'));
    w.ws.send(JSON.stringify({ type: 'ack', seq: foreign.commitment.seq }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await store.commitment(foreign.commitment.seq))?.state).toBe('pending');
    w.ws.close();
  });

  it("a watcher never receives another seller's vouchers", async () => {
    const otherKey = testKey('other-seller');
    const other = addressOf(otherKey);
    await store.appendPending(voucher(100n, 'o1', other));
    const w = await connectWatcher({});
    await until(() => w.received.some((m) => m.type === 'welcome'));
    await new Promise((r) => setTimeout(r, 50));
    expect(w.received.filter((m) => m.type === 'commitment')).toHaveLength(0);
    w.ws.close();
  });
});
