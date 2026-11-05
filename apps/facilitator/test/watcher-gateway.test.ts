import Fastify, { type FastifyInstance } from 'fastify';
import obyte from 'obyte';
import {
  type AppendInput,
  type ServerMessage,
  SqliteBatchStore,
  SqliteSettlementStore,
  loginMessage,
  packageHashOf,
  receiptMessage,
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

/** A distinct package per tag; its packageHash is the real hash the watcher signs. */
const pkgOf = (tag: string) => ({ signed_message: { tag } });

const voucher = (amountSpent: bigint, tag: string, payTo = seller): AppendInput => ({
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
  packageHash: packageHashOf(pkgOf(tag)),
  packageJson: JSON.stringify(pkgOf(tag)),
});

/** A receipt as the real watcher signs it. */
const receipt = (
  type: 'ack' | 'nack',
  seq: number,
  packageHash: string,
  key: Uint8Array = sellerKey,
) =>
  JSON.stringify({
    type,
    seq,
    receipt: obyte.utils.signMessage(
      receiptMessage(type, NET, { seq, packageHash, reason: 'not_increasing' }),
      { privateKey: key, testnet: true },
    ),
  });

/** Minimal watcher client (the real one lives in apps/watcher). */
async function connectWatcher(opts: {
  key?: Uint8Array;
  cursor?: number;
  bytes?: string;
  network?: string;
  signNetwork?: boolean;
  /** null = a version-1 watcher (no protocol field). */
  protocol?: number | null;
  /** How the watcher answers commitments (default: signed ack). */
  answer?: 'ack' | 'nack' | 'none';
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
          ...(opts.protocol === null ? {} : { protocol: opts.protocol ?? 2 }),
          network: opts.network ?? NET,
          login,
          cursor: opts.cursor ?? 0,
          bytesBalance: opts.bytes ?? '1000000',
        }),
      );
    }
    const answer = opts.answer ?? 'ack';
    if (msg.type === 'commitment' && answer !== 'none')
      ws.send(receipt(answer, msg.seq, packageHashOf(msg.signedPackage)));
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

  it('refuses an old (version 1) watcher at login with a clear reason', async () => {
    const w = await connectWatcher({ protocol: null });
    const closed = await w.closed;
    expect(closed.code).toBe(4001);
    expect(closed.reason).toMatch(/protocol 1 is not supported/);
    expect(gateway.health(seller, NET).ok).toBe(false);
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
    expect(await gateway.deliver(appended.commitment, 1000)).toEqual({ kind: 'acked' });
    expect((await store.commitment(appended.commitment.seq))?.state).toBe('committed');
    w.ws.close();
  });

  it('no ack → timeout; nobody connected → timeout immediately', async () => {
    const appended = await store.appendPending(voucher(100n, 'h2'));
    if (!appended.ok) throw new Error('append failed');
    expect(await gateway.deliver(appended.commitment, 100)).toEqual({ kind: 'timeout' });
    const w = await connectWatcher({ answer: 'none' });
    await until(() => gateway.health(seller, NET).ok);
    expect(await gateway.deliver(appended.commitment, 100)).toEqual({ kind: 'timeout' });
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
    // signed by us, for the foreign entry's real package: still not ours
    w.ws.send(receipt('ack', foreign.commitment.seq, foreign.commitment.packageHash));
    w.ws.send(receipt('nack', foreign.commitment.seq, foreign.commitment.packageHash));
    await new Promise((r) => setTimeout(r, 100));
    expect((await store.commitment(foreign.commitment.seq))?.state).toBe('pending');
    w.ws.close();
  });

  it('a signed nack cancels the voucher and frees the channel', async () => {
    const w = await connectWatcher({ answer: 'nack' });
    await until(() => gateway.health(seller, NET).ok);
    const appended = await store.appendPending(voucher(100n, 'n1'));
    if (!appended.ok) throw new Error('append failed');
    expect(await gateway.deliver(appended.commitment, 1000)).toEqual({
      kind: 'refused',
      reason: 'not_increasing',
    });
    expect((await store.commitment(appended.commitment.seq))?.state).toBe('cancelled');
    expect((await store.channel(appended.commitment.channelKey))?.pendingSeq).toBeNull();
    w.ws.close();
  });

  it('forged receipts change nothing: bare seq, wrong signer, wrong package', async () => {
    const w = await connectWatcher({ answer: 'none' });
    await until(() => gateway.health(seller, NET).ok);
    const appended = await store.appendPending(voucher(100n, 'g1'));
    if (!appended.ok) throw new Error('append failed');
    const { seq, packageHash } = appended.commitment;
    const delivery = gateway.deliver(appended.commitment, 300);
    // a receipt signed by someone other than the seller
    w.ws.send(receipt('ack', seq, packageHash, testKey('mallory')));
    // the seller's signature for another package under this seq (journal reset)
    w.ws.send(receipt('ack', seq, packageHashOf(pkgOf('other'))));
    w.ws.send(receipt('nack', seq, packageHashOf(pkgOf('other'))));
    await new Promise((r) => setTimeout(r, 100));
    expect((await store.commitment(seq))?.state).toBe('pending'); // socket still open: all checked
    // the old protocol's bare ack (what a relay could forge): malformed, connection dropped
    w.ws.send(JSON.stringify({ type: 'ack', seq }));
    expect(await delivery).toEqual({ kind: 'timeout' });
    expect((await store.commitment(seq))?.state).toBe('pending');
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
