import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { x402Client } from '@x402/core/client';
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import {
  CHANNEL_BASE_AA,
  LEGACY_CHANNEL_BASE_AAS,
  OBYTE_NETWORKS,
  channelAddress,
  channelDefinition,
} from '@obbyx/obyte';
import type obyte from 'obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BatchObyteClient,
  type BatchObyteClientOptions,
  closeChannel,
  confirmClose,
  deposit,
  openChannel,
  recoverChannels,
} from '../src/batch/client.js';
import { ClientChannelStore, type PendingVoucher } from '../src/batch/client-store.js';
import type { ReservingComposer } from '../src/coins/index.js';
import { addressOf, testKey, silentLogger } from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';
import { offlineComposer } from './offline-composer.js';

/**
 * Buyer-side safety of AA channels (invariants I1–I8): what the client
 * declares on close, when it refuses to sign, and how its local state follows
 * the chain.
 */
const NET = OBYTE_NETWORKS.testnet;
const LEGACY = LEGACY_CHANNEL_BASE_AAS[0]!;
const sellerKey = testKey('seller');
const seller = addressOf(sellerKey);
const clientKey = testKey('client');
const me = addressOf(clientKey);
const AA = 'A'.repeat(32);
const OLD_AA = 'O'.repeat(32);
const silent = silentLogger();
const b = (c: string) => c.repeat(64);

const req = (binding: string, extra: Record<string, unknown> = {}): PaymentRequirements => ({
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
    ...extra,
  },
});

const voucher = (binding: string, period: number, amountSpent: number): PendingVoucher => ({
  binding,
  period,
  amountSpent: String(amountSpent),
  signedPackage: {},
});

let dir: string;
let path: string;
let hub: FakeHub;
let store: ClientChannelStore;
let now: number;
const stores: ClientChannelStore[] = [];

/** obyte.js client composing offline; state and posts go to the FakeHub. */
function hubClient(api: object = {}): obyte.Client {
  const c = offlineComposer(me);
  Object.assign(
    (c as unknown as { api: object }).api,
    { getAaStateVars: hub.client.api.getAaStateVars, postJoint: hub.client.api.postJoint },
    api,
  );
  return c;
}

function options(s: ClientChannelStore = store, extra: Partial<BatchObyteClientOptions> = {}) {
  return {
    client: hubClient(),
    network: NET,
    privateKey: clientKey,
    store: s,
    logger: silent,
    maxAmount: new Map([['base', 1_000n]]),
    now: () => now,
    ...extra,
  } satisfies BatchObyteClientOptions;
}

const batch = (s: ClientChannelStore = store, extra: Partial<BatchObyteClientOptions> = {}) =>
  new BatchObyteClient(options(s, extra));

function openStore(p = path): ClientChannelStore {
  const s = new ClientChannelStore(p);
  stores.push(s);
  return s;
}

function addChannel(s: ClientChannelStore, aa = AA, extra: { baseAa?: string } = {}) {
  s.add({
    network: NET.caip2,
    aa,
    payTo: seller,
    asset: 'base',
    timeout: 3600,
    salt: 's',
    openedUnit: null,
    funded: true,
    ...extra,
  });
}

/** Messages of the last posted unit. */
function lastUnit(): { data: Record<string, unknown>; paidTo: string[] } {
  const messages = [...hub.joints.values()].at(-1)?.['messages'] as {
    app: string;
    payload: { outputs?: { address: string }[] };
  }[];
  return {
    data: messages.find((m) => m.app === 'data')?.payload as Record<string, unknown>,
    paidTo: (messages.find((m) => m.app === 'payment')?.payload.outputs ?? []).map(
      (o) => o.address,
    ),
  };
}
const lastData = () => lastUnit().data;

const amountOf = (r: { payload: Record<string, unknown> }) =>
  (
    r.payload['signedPackage'] as {
      signed_message: { aa_address: string; amount_spent: number; period: number };
    }
  ).signed_message;

const recoverable = (salt: string) => {
  const params = { addressA: seller, addressB: me, asset: 'base', salt, timeout: 7200 };
  const aa = channelAddress(params, CHANNEL_BASE_AA);
  const entry = { address: aa, definition: channelDefinition(params, CHANNEL_BASE_AA), unit: 'U' };
  return { aa, getAasByBaseAas: async () => [entry] };
};

/** A database file in the given released schema, with one channel row. */
function releasedDb(
  file: string,
  schema: 'head' | 'older',
  row: { period: number; committed: number; maxSigned?: number; pending?: PendingVoucher },
): string {
  const p = join(dir, file);
  const db = new DatabaseSync(p);
  const maxSigned = schema === 'head' ? `max_signed TEXT NOT NULL DEFAULT '0',` : '';
  db.exec(`CREATE TABLE client_channels (
    aa TEXT PRIMARY KEY, network TEXT NOT NULL, pay_to TEXT NOT NULL, asset TEXT NOT NULL,
    timeout INTEGER NOT NULL, salt TEXT NOT NULL, period INTEGER NOT NULL,
    committed TEXT NOT NULL, ${maxSigned} pending_json TEXT, opened_unit TEXT, created_at INTEGER NOT NULL
  ) STRICT`);
  db.prepare(
    `INSERT INTO client_channels (aa, network, pay_to, asset, timeout, salt, period, committed,
       ${schema === 'head' ? 'max_signed,' : ''} pending_json, opened_unit, created_at)
     VALUES (?, ?, ?, 'base', 3600, 's', ?, ?, ${schema === 'head' ? '?,' : ''} ?, NULL, 0)`,
  ).run(
    AA,
    NET.caip2,
    seller,
    row.period,
    String(row.committed),
    ...(schema === 'head' ? [String(row.maxSigned ?? 0)] : []),
    row.pending === undefined ? null : JSON.stringify(row.pending),
  );
  db.close();
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obbyx-client-'));
  path = join(dir, 'channels.db');
  hub = new FakeHub();
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000_000 });
  store = openStore();
  addChannel(store);
  now = 1_000_000;
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('I1: a close freezes signing in its period, across processes', () => {
  it('declares the highest signed amount, then refuses to sign before the close is even visible on-chain', async () => {
    await batch().createPaymentPayload(2, req(b('a')));
    batch().onSettled(req(b('a')), { success: true, transaction: '', network: NET.caip2 });
    await batch().createPaymentPayload(2, req(b('b'))); // 200, pending

    expect(await closeChannel(options(), AA)).toMatchObject({
      kind: 'requested',
      period: 1,
      declared: 200n,
    });
    expect(lastData()).toEqual({ close: 1, period: 1, transferredFromMe: 200 });
    // another process sharing the database, while the close is not on-chain yet
    const other = openStore();
    expect(other.get(AA)?.lastClose).toEqual({ period: 1, declared: 200n, state: 'posted' });
    await expect(batch(other).createPaymentPayload(2, req(b('c')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(other.setPending(AA, voucher(b('d'), 1, 300))).toBe(false);
    expect(other.get(AA)?.maxSigned).toBe(200n);
  });

  it('a voucher signed by another process while the close is being broadcast is refused (no TOCTOU)', async () => {
    const other = openStore();
    let raced: unknown;
    const client = hubClient({
      postJoint: async (p: { unit: Record<string, unknown> }) => {
        raced = await batch(other)
          .createPaymentPayload(2, req(b('e')))
          .catch((e: unknown) => e);
        return hub.client.api.postJoint(p);
      },
    });
    expect(await closeChannel({ ...options(), client }, AA)).toMatchObject({ declared: 0n });
    expect(raced).toMatchObject({ code: 'channel_closing' });
    expect(other.get(AA)).toMatchObject({ pending: null, maxSigned: 0n });
  });

  it('the close is over once the chain shows a later period, also when our period was ahead', async () => {
    store.newPeriod(AA, 2); // a hub once reported period 2 (a lie)
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 }); // the truth
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', period: 1 });
    await expect(batch().createPaymentPayload(2, req(b('a')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    hub.aaVars.set(AA, { period: 2, balanceB: 5000 }); // the close was confirmed
    const signed = await batch().createPaymentPayload(2, req(b('a')));
    expect(amountOf(signed)).toMatchObject({ period: 2, amount_spent: 100 });
  });

  it('a close recorded for a period a hub lied about blocks neither deposits nor the real period', async () => {
    hub.aaVars.set(AA, { period: 3, balanceB: 5000 }); // a lie
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', period: 3 });
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 }); // the truth
    expect(await deposit(options(), AA, 20_000n)).toMatch(/^.{44}$/);
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', period: 1 });
    await expect(deposit(options(), AA, 20_000n)).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(store.setPending(AA, voucher(b('a'), 1, 1))).toBe(false);
  });

  it('a close pending on-chain stops signing in its period', async () => {
    store.newPeriod(AA, 2);
    store.beginClose(AA, 1);
    store.markClosing(AA, 2);
    hub.aaVars.set(AA, { period: 2, balanceB: 5000 });
    await expect(batch().createPaymentPayload(2, req(b('a')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(store.setPending(AA, voucher(b('a'), 2, 1))).toBe(false);
  });
});

describe('I2: the declaration never goes below what was signed or sent', () => {
  it('a voucher recorded (pending) before the close is declared, also from another process', async () => {
    expect(openStore().setPending(AA, voucher(b('a'), 1, 700))).toBe(true);
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', declared: 700n });
  });

  it('a hub reporting a higher period does not lower the declaration of the real one', async () => {
    store.setPending(AA, voucher(b('a'), 1, 700));
    hub.aaVars.set(AA, { period: 2, balanceB: 5000 }); // a lie
    await batch()
      .createPaymentPayload(2, req(b('b')))
      .catch(() => undefined);
    expect(store.get(AA)).toMatchObject({ period: 2, committed: 0n, maxSigned: 100n });
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 }); // the truth
    expect(await closeChannel(options(), AA)).toMatchObject({ period: 1, declared: 700n });
    expect(lastData()).toMatchObject({ period: 1, transferredFromMe: 700 });
  });

  it('a close that may have been sent (unknown, posted, "rejected") is a floor, even after a later period', () => {
    for (const state of ['unknown', 'posted', 'rejected'] as const) {
      const aa = `${state}`.padEnd(32, 'X');
      addChannel(store, aa);
      store.beginClose(aa, 1, { declare: 500n });
      store.setCloseState(aa, 1, state);
      store.newPeriod(aa, 2); // a hub reports period 2
      expect(store.beginClose(aa, 1)).toMatchObject({ declared: 500n, previous: state });
      expect(() => store.beginClose(aa, 1, { declare: 100n })).toThrow(/declaring 100/);
      expect(() => store.beginClose(aa, 1, { force: true, declare: 499n })).toThrow(
        /declare_too_low|at least 500/,
      );
    }
  });

  it('a posted close can be raised, never lowered; it is not resent without --resend', async () => {
    await batch().createPaymentPayload(2, req(b('a'))); // 100 pending
    expect(await closeChannel(options(), AA)).toMatchObject({ declared: 100n, outcome: 'ok' });
    const posted = hub.calls['postJoint'];
    expect(await closeChannel(options(), AA)).toMatchObject({
      kind: 'sent_earlier',
      declared: 100n,
      state: 'posted',
    });
    expect(hub.calls['postJoint']).toBe(posted);
    await expect(closeChannel(options(), AA, { declare: 50n })).rejects.toMatchObject({
      code: 'declare_too_low',
    });
    expect(await closeChannel(options(), AA, { declare: 250n })).toMatchObject({
      kind: 'requested',
      previous: 'posted',
      declared: 250n,
    });
    expect(lastData()).toMatchObject({ period: 1, transferredFromMe: 250 });
    await expect(closeChannel(options(), AA, { declare: 200n })).rejects.toMatchObject({
      code: 'declare_too_low',
    });
    expect(await closeChannel(options(), AA, { resend: true })).toMatchObject({
      kind: 'requested',
      declared: 250n,
    });
  });

  it('a prepared close replaced by another process meanwhile is not broadcast', async () => {
    store.setPending(AA, voucher(b('a'), 1, 100));
    const other = openStore();
    // While this process composes its close (--declare 1000), another one
    // replaces the prepared declaration with --force (100) and posts it.
    const racing = {
      compose: async (fn: () => Promise<unknown>) => {
        await closeChannel(options(other), AA, { force: true });
        return fn();
      },
    } as unknown as ReservingComposer;
    await expect(
      closeChannel(options(store, { composer: racing }), AA, { declare: 1000n }),
    ).rejects.toMatchObject({ code: 'close_superseded' });
    expect(hub.calls['postJoint']).toBe(1);
    expect(lastData()).toMatchObject({ period: 1, transferredFromMe: 100 });
    expect(store.get(AA)?.lastClose).toEqual({ period: 1, declared: 100n, state: 'posted' });
  });

  it('a close that was never posted is retried by itself; new options apply (never below what was signed)', async () => {
    const failing = {
      compose: async () => Promise.reject(new Error('not enough funds')),
    } as unknown as ReservingComposer;
    await batch().createPaymentPayload(2, req(b('a'))); // 100 pending
    await expect(
      closeChannel(options(store, { composer: failing }), AA, { declare: 900n }),
    ).rejects.toThrow(/not enough funds/);
    expect(store.get(AA)?.lastClose).toEqual({ period: 1, declared: 900n, state: 'prepared' });
    expect(hub.calls['postJoint']).toBeUndefined();
    await expect(batch().createPaymentPayload(2, req(b('b')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    await expect(closeChannel(options(), AA, { declare: 50n })).rejects.toMatchObject({
      code: 'declare_too_low',
    });
    expect(store.beginClose(AA, 1)).toMatchObject({ declared: 900n, previous: 'prepared' });
    expect(await closeChannel(options(), AA, { declare: 300n })).toMatchObject({
      kind: 'requested',
      declared: 300n,
      previous: 'prepared',
    });
    expect(lastData()).toMatchObject({ transferredFromMe: 300 });
  });

  it('after a definite rejection, close sends again without --resend; signing stays stopped', async () => {
    await batch().createPaymentPayload(2, req(b('a'))); // 100 pending
    hub.post = 'reject';
    await expect(closeChannel(options(), AA)).rejects.toMatchObject({
      code: 'broadcast_rejected',
    });
    expect(store.get(AA)?.lastClose).toEqual({ period: 1, declared: 100n, state: 'rejected' });
    await expect(batch().createPaymentPayload(2, req(b('b')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    hub.post = 'accept';
    expect(await closeChannel(options(), AA)).toMatchObject({
      kind: 'requested',
      declared: 100n,
      previous: 'rejected',
      outcome: 'ok',
    });
    expect(store.get(AA)?.lastClose?.state).toBe('posted');
  });

  it('an unknown outcome is not sent again by itself; a posted close is never downgraded', async () => {
    hub.post = 'drop';
    expect(await closeChannel(options(), AA)).toMatchObject({ outcome: 'unknown' });
    expect(await closeChannel(options(), AA)).toMatchObject({
      kind: 'sent_earlier',
      state: 'unknown',
    });
    hub.post = 'accept';
    await closeChannel(options(), AA, { resend: true });
    hub.post = 'reject';
    await expect(closeChannel(options(), AA, { resend: true })).rejects.toMatchObject({
      code: 'broadcast_rejected',
    });
    expect(store.get(AA)?.lastClose?.state).toBe('posted');
  });
});

describe('I3: uncertain periods need an explicit declaration', () => {
  it('a period migrated from before max_signed: --declare (not below the known) or --force', async () => {
    const m = openStore(releasedDb('older.db', 'older', { period: 1, committed: 500 }));
    expect(m.get(AA)).toMatchObject({ maxSigned: 500n, uncertainty: 'migrated' });
    await expect(closeChannel(options(m), AA)).rejects.toMatchObject({
      code: 'max_signed_uncertain',
      details: { period: 1, reason: 'migrated', known: '500' },
    });
    expect(hub.calls['postJoint']).toBeUndefined();
    expect(m.get(AA)?.lastClose).toBeNull(); // nothing frozen by a refused close
    await expect(closeChannel(options(m), AA, { declare: 400n })).rejects.toMatchObject({
      code: 'declare_too_low',
    });
    expect(await closeChannel(options(m), AA, { force: true })).toMatchObject({ declared: 500n });
  });

  it('the flag is per period, survives a lying hub and reopening, and is never cleared', async () => {
    const p = releasedDb('older2.db', 'older', { period: 1, committed: 500 });
    const m = openStore(p);
    hub.aaVars.set(AA, { period: 2, balanceB: 5000 }); // a lie
    expect(await closeChannel(options(m), AA)).toMatchObject({ period: 2, declared: 0n });
    expect(m.get(AA)?.uncertainty).toBeNull(); // period 2 is certain
    const again = openStore(p);
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 }); // the truth
    await expect(closeChannel(options(again), AA)).rejects.toMatchObject({
      code: 'max_signed_uncertain',
      details: { period: 1 },
    });
    expect(await closeChannel(options(again), AA, { declare: 900n })).toMatchObject({
      period: 1,
      declared: 900n,
    });
    expect(lastData()).toMatchObject({ period: 1, transferredFromMe: 900 });
  });

  it('a recovered channel is uncertain in every period, whatever the hub reported', async () => {
    const { aa, getAasByBaseAas } = recoverable('lost');
    const opts = { ...options(), client: hubClient({ getAasByBaseAas }) };
    hub.aaVars.set(aa, { period: 1, balanceB: 50_000 }); // a lagging or lying hub
    expect((await recoverChannels(opts)).map((c) => c.aa)).toEqual([aa]);
    expect(store.get(aa)).toMatchObject({ payTo: seller, timeout: 7200, uncertainty: 'recovered' });
    hub.aaVars.set(aa, { period: 3, balanceB: 50_000 }); // the truth
    await expect(closeChannel(opts, aa)).rejects.toMatchObject({
      code: 'max_signed_uncertain',
      details: { period: 3, reason: 'recovered' },
    });
    expect(hub.calls['postJoint']).toBeUndefined();
    expect(await closeChannel(opts, aa, { declare: 30_000n })).toMatchObject({
      period: 3,
      declared: 30_000n,
    });
    store.newPeriod(aa, 4);
    expect(store.get(aa)?.uncertainty).toBe('recovered');
  });

  it('recover skips channels already known and definitions that are not ours', async () => {
    const { aa, getAasByBaseAas } = recoverable('x');
    const entries = [
      ...(await getAasByBaseAas()),
      { address: AA, definition: ['autonomous agent', {}], unit: 'X' },
    ];
    const client = hubClient({ getAasByBaseAas: async () => entries });
    expect((await recoverChannels({ ...options(), client })).map((c) => c.aa)).toEqual([aa]);
  });
});

describe('I4: one pending voucher, recorded before it leaves, retried as is', () => {
  it('records the voucher with its header and raises maxSigned before returning it', async () => {
    await batch().createPaymentPayload(2, req(b('a')));
    const ch = openStore().get(AA)!;
    expect(ch.maxSigned).toBe(100n);
    expect(decodePaymentSignatureHeader(ch.pending!.paymentHeader!)).toMatchObject({
      x402Version: 2,
      accepted: { scheme: 'batch-settlement', payTo: seller, extra: { binding: b('a') } },
      payload: { signedPackage: ch.pending!.signedPackage },
    });
  });

  it('another operation is refused while a voucher is pending, with its retry header; the same one resends it', async () => {
    const client = batch();
    const first = await client.createPaymentPayload(2, req(b('a')));
    client.rememberPaymentHeader(req(b('a')), 'HEADER');
    await expect(client.createPaymentPayload(2, req(b('b')))).rejects.toMatchObject({
      code: 'payment_pending',
      details: { aa: AA, paymentHeader: 'HEADER' },
    });
    expect(await client.createPaymentPayload(2, req(b('a')))).toEqual(first);
    expect(openStore().get(AA)?.pending?.paymentHeader).toBe('HEADER');
  });

  it('a retried operation resends its voucher on its own channel only; a new one may use another', async () => {
    const NEW_AA = 'N'.repeat(32);
    const client = batch();
    const op1 = await client.createPaymentPayload(2, req(b('1')));
    addChannel(store, NEW_AA); // newer: first candidate
    hub.aaVars.set(NEW_AA, { period: 1, balanceB: 1_000_000 });
    expect(await client.createPaymentPayload(2, req(b('1')))).toEqual(op1);
    client.rememberPaymentHeader(req(b('1')), 'HEADER-1');
    expect(store.get(AA)?.pending).toMatchObject({ binding: b('1'), paymentHeader: 'HEADER-1' });
    expect(store.get(NEW_AA)?.pending).toBeNull();
    // a new operation: the first candidate (NEW_AA) is free
    expect(amountOf(await client.createPaymentPayload(2, req(b('2')))).aa_address).toBe(NEW_AA);
    client.onSettled(req(b('1')), { success: true, transaction: '', network: NET.caip2 });
    // another new one: NEW_AA holds 2, AA is free again
    expect(amountOf(await client.createPaymentPayload(2, req(b('3')))).aa_address).toBe(AA);
    await expect(client.createPaymentPayload(2, req(b('4')))).rejects.toMatchObject({
      code: 'payment_pending',
    });
    // 2 retried while its channel is closing: refused, never signed on AA
    client.onSettled(req(b('3')), { success: true, transaction: '', network: NET.caip2 });
    hub.aaVars.set(NEW_AA, {
      period: 1,
      balanceB: 1,
      close_initiated_by: 'A',
      close_start_ts: now,
    });
    await expect(client.createPaymentPayload(2, req(b('2')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(store.get(AA)?.pending).toBeNull();
  });

  it('a pending voucher of an older period is void once the chain shows a new one', async () => {
    await batch().createPaymentPayload(2, req(b('a')));
    hub.aaVars.set(AA, { period: 2, balanceB: 5000 });
    const next = await batch().createPaymentPayload(2, req(b('b')));
    expect(amountOf(next)).toMatchObject({ period: 2, amount_spent: 100 });
    expect(store.get(AA)?.pending).toMatchObject({ binding: b('b'), period: 2 });
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 });
    expect(store.beginClose(AA, 1)).toMatchObject({ declared: 100n }); // history kept
  });

  it('a pending voucher never blocks closing: it is declared', async () => {
    await batch().createPaymentPayload(2, req(b('a')));
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', declared: 100n });
  });

  it('the official x402 client path (schemeHooks) records the header it really sends', async () => {
    const official = new x402Client()
      .setSpendControls({
        allowedAssets: [{ network: NET.caip2, asset: 'base', maxAmountPerPayment: '1000' }],
      })
      .register(NET.caip2 as `${string}:${string}`, batch());
    const payment = await official.createPaymentPayload({
      x402Version: 2,
      resource: { url: 'https://seller.example/api', description: '', mimeType: '' },
      accepts: [req(b('a'))],
      extensions: { note: { info: 1 } },
    });
    expect(store.get(AA)?.pending?.paymentHeader).toBe(encodePaymentSignatureHeader(payment));
  });
});

describe('I5: legacy channels are never paid into, only closed', () => {
  beforeEach(() => {
    addChannel(store, OLD_AA, { baseAa: LEGACY });
    hub.aaVars.set(OLD_AA, { period: 1, balanceB: 1_000_000 });
  });

  it('only channels on the current base AA, offered by the seller, are used', async () => {
    expect(store.get(OLD_AA)).toMatchObject({ legacy: true, baseAa: LEGACY });
    expect(store.find(NET.caip2, seller, 'base')?.aa).toBe(AA);
    expect(batch().hasChannel(req(b('a'), { baseAa: LEGACY }))).toBe(false);
  });

  it('with only a legacy channel there is nothing to pay with, and no deposit', async () => {
    const only = openStore(':memory:');
    addChannel(only, OLD_AA, { baseAa: LEGACY });
    expect(batch(only).hasChannel(req(b('a')))).toBe(false);
    await expect(batch(only).createPaymentPayload(2, req(b('a')))).rejects.toMatchObject({
      code: 'no_channel',
    });
    expect(only.setPending(OLD_AA, voucher(b('a'), 1, 1))).toBe(false);
    await expect(deposit(options(only), OLD_AA, 20_000n)).rejects.toMatchObject({
      code: 'legacy_channel',
    });
  });

  it('no deposit into a channel that is not in the store', async () => {
    const unknown = 'U'.repeat(32);
    hub.aaVars.set(unknown, { period: 1, balanceB: 0 });
    await expect(deposit(options(), unknown, 20_000n)).rejects.toMatchObject({
      code: 'no_channel',
    });
    expect(hub.calls['postJoint']).toBeUndefined();
  });

  it('a legacy channel can still be closed and confirmed, at its own address', async () => {
    expect(await closeChannel(options(), OLD_AA)).toMatchObject({ kind: 'requested', period: 1 });
    expect(lastUnit().paidTo).toContain(OLD_AA);
    hub.aaVars.set(OLD_AA, { period: 1, close_initiated_by: 'A', close_start_ts: now });
    expect(await confirmClose(options(), OLD_AA)).toMatchObject({ period: 1 });
    expect(lastUnit()).toMatchObject({ data: { confirm: 1, period: 1 } });
    expect(lastUnit().paidTo).toContain(OLD_AA);
  });
});

describe('I6: close and confirm follow the on-chain state', () => {
  it('closes the ON-CHAIN period, advancing the local one', async () => {
    hub.aaVars.set(AA, { period: 3, balanceB: 5000 });
    expect(await closeChannel(options(), AA)).toMatchObject({ kind: 'requested', period: 3 });
    expect(lastData()).toMatchObject({ close: 1, period: 3 });
    expect(store.get(AA)?.period).toBe(3);
  });

  it("the seller's pending close: never a second close, no voucher, confirm at once", async () => {
    hub.aaVars.set(AA, { period: 2, balanceB: 5000, close_initiated_by: 'A', close_start_ts: now });
    expect(await closeChannel(options(), AA)).toMatchObject({
      kind: 'already_closing',
      by: 'A',
      period: 2,
      confirmableAt: 0,
    });
    expect(hub.calls['postJoint']).toBeUndefined();
    await expect(batch().createPaymentPayload(2, req(b('a')))).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(store.setPending(AA, voucher(b('a'), 2, 1))).toBe(false);
    expect(await confirmClose(options(), AA)).toMatchObject({ period: 2, by: 'A' });
    expect(lastData()).toEqual({ confirm: 1, period: 2 });
  });

  it('our own close: confirm only after close_start_ts + timeout', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 5000, close_initiated_by: 'B', close_start_ts: now });
    await expect(confirmClose(options(), AA)).rejects.toMatchObject({ code: 'too_early' });
    expect(hub.calls['postJoint']).toBeUndefined();
    now += 3600;
    expect(await confirmClose(options(), AA)).toMatchObject({ period: 1, by: 'B' });
    expect(lastData()).toEqual({ confirm: 1, period: 1 });
  });

  it('confirm without a pending close is refused', async () => {
    await expect(confirmClose(options(), AA)).rejects.toMatchObject({ code: 'not_closing' });
  });

  it('deposit is refused while a close is pending (on-chain, or ours not yet visible)', async () => {
    hub.aaVars.set(AA, { period: 1, balanceB: 5000, close_initiated_by: 'A', close_start_ts: now });
    await expect(deposit(options(), AA, 20_000n)).rejects.toMatchObject({
      code: 'channel_closing',
    });
    hub.aaVars.set(AA, { period: 1, balanceB: 5000 });
    await closeChannel(options(), AA);
    const posted = hub.calls['postJoint'];
    await expect(deposit(options(), AA, 20_000n)).rejects.toMatchObject({
      code: 'channel_closing',
    });
    expect(hub.calls['postJoint']).toBe(posted);
    hub.aaVars.set(AA, { period: 2 }); // that close is over
    expect(await deposit(options(), AA, 20_000n)).toMatch(/^.{44}$/);
  });
});

describe('I7: signing needs a cap; answers are matched on binding and period', () => {
  it('refuses to sign without a per-call limit for the asset', async () => {
    await expect(
      batch(store, { maxAmount: new Map() }).createPaymentPayload(2, req(b('a'))),
    ).rejects.toMatchObject({ code: 'no_spending_limit' });
    expect(store.get(AA)?.pending).toBeNull();
  });

  it('a late answer about an older voucher or period changes nothing', () => {
    store.setPending(AA, voucher(b('a'), 1, 100));
    store.newPeriod(AA, 2);
    store.setPending(AA, voucher(b('b'), 2, 50));
    expect(store.confirm(AA, { binding: b('a'), period: 1 }, 100n)).toBe(false);
    expect(store.dropPending(AA, { binding: b('a'), period: 1 })).toBe(false);
    expect(store.confirm(AA, { binding: b('b'), period: 1 }, 50n)).toBe(false);
    expect(store.get(AA)).toMatchObject({ period: 2, committed: 0n, pending: { binding: b('b') } });
    expect(store.confirm(AA, { binding: b('b'), period: 2 }, 50n)).toBe(true);
    expect(store.get(AA)).toMatchObject({ period: 2, committed: 50n, pending: null });
  });

  it('onSettled for another binding leaves the pending voucher alone', async () => {
    const client = batch();
    await client.createPaymentPayload(2, req(b('a')));
    client.onSettled(req(b('z')), { success: true, transaction: '', network: NET.caip2 });
    expect(store.get(AA)).toMatchObject({ committed: 0n, pending: { binding: b('a') } });
  });
});

describe('I8: released databases migrate; the schema version is guarded', () => {
  it('the released schema (with max_signed): v1.1 channels, uncertain (it reset max_signed on a lying hub)', () => {
    const m = openStore(releasedDb('head.db', 'head', { period: 2, committed: 50, maxSigned: 80 }));
    expect(m.get(AA)).toMatchObject({
      baseAa: LEGACY,
      legacy: true,
      maxSigned: 80n,
      uncertainty: 'migrated',
      funded: true,
    });
    expect(m.find(NET.caip2, seller, 'base')).toBeUndefined();
    expect(() => m.beginClose(AA, 2)).toThrow(/older obbyx version/);
    expect(m.beginClose(AA, 2, { force: true })).toMatchObject({ declared: 80n });
    m.newPeriod(AA, 3);
    expect(m.get(AA)?.uncertainty).toBeNull(); // only the migrated period
  });

  it('the older schema (without max_signed): seeded from committed and the pending voucher, uncertain', () => {
    const p = releasedDb('older.db', 'older', {
      period: 3,
      committed: 800,
      pending: voucher(b('a'), 3, 900),
    });
    expect(openStore(p).get(AA)).toMatchObject({ maxSigned: 900n, uncertainty: 'migrated' });
  });

  it('the version is written, and a database from a newer version is refused', () => {
    const raw = new DatabaseSync(path);
    const version = (raw.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    expect(version).toBeGreaterThan(0);
    raw.exec(`PRAGMA user_version = ${version + 1}`);
    raw.close();
    expect(() => new ClientChannelStore(path)).toThrow(/newer obbyx version/);
    // refused before anything is written (no switch to WAL)
    const fresh = join(dir, 'newer.db');
    const db = new DatabaseSync(fresh);
    db.exec(`PRAGMA user_version = ${version + 1}`);
    db.close();
    expect(() => new ClientChannelStore(fresh)).toThrow(/newer obbyx version/);
    const after = new DatabaseSync(fresh);
    expect(after.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    after.close();
  });
});

describe('opening a channel is crash-safe', () => {
  it('the row is written before the unit is posted; a definite rejection forgets it', async () => {
    const s = openStore(':memory:');
    let seen: unknown;
    const client = hubClient({
      postJoint: async () => {
        seen = s.list()[0];
        return 'accepted';
      },
    });
    const { aa, outcome } = await openChannel(
      { ...options(s), client },
      { payTo: seller, deposit: 100_000n, timeout: 3600 },
    );
    expect(seen).toMatchObject({ aa, baseAa: CHANNEL_BASE_AA, funded: false });
    expect(outcome).toBe('ok');

    hub.post = 'reject';
    await expect(
      openChannel(options(s), { payTo: seller, deposit: 100_000n, timeout: 3600 }),
    ).rejects.toMatchObject({ code: 'broadcast_rejected' });
    expect(s.list().map((c) => c.aa)).toEqual([aa]);
  });

  it('a newer unfunded channel does not shadow a funded one', async () => {
    hub.post = 'drop';
    const { aa, outcome } = await openChannel(options(), {
      payTo: seller,
      deposit: 100_000n,
      timeout: 3600,
    });
    expect(outcome).toBe('unknown');
    expect(store.get(aa)).toBeDefined();
    expect(store.find(NET.caip2, seller, 'base')?.aa).toBe(AA);
    // even once both are "funded" in the store order, the unfunded one is skipped by the ledger
    store.markFunded(aa);
    const signed = await batch().createPaymentPayload(2, req(b('a')));
    expect(
      (signed.payload['signedPackage'] as { signed_message: { aa_address: string } }).signed_message
        .aa_address,
    ).toBe(AA);
  });
});
