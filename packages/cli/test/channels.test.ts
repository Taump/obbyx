import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL_BASE_AA,
  LEGACY_CHANNEL_BASE_AAS,
  OBYTE_NETWORKS,
  channelAddress,
  channelDefinition,
} from '@obbyx/obyte';
import { ClientChannelStore } from '@obbyx/x402-obyte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelCommand, channelStorePath } from '../src/lib/channels.js';
import { addressOf, silentLogger, testKey } from '../../obyte/test/helpers.js';
import { FakeHub } from '../../x402-obyte/test/fake-hub.js';
import { offlineComposer } from '../../x402-obyte/test/offline-composer.js';

const NET = OBYTE_NETWORKS.testnet;
const seller = addressOf(testKey('seller'));
const key = testKey('client');
const AA = 'A'.repeat(32);
const OLD_AA = 'O'.repeat(32);

let home: string;
let saved: string | undefined;
let hub: FakeHub;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'obbyx-cli-'));
  saved = process.env['OBBYX_HOME'];
  process.env['OBBYX_HOME'] = home;
  hub = new FakeHub();
  hub.aaVars.set(AA, { period: 1, balanceB: 1_000_000 });
});

afterEach(() => {
  if (saved === undefined) delete process.env['OBBYX_HOME'];
  else process.env['OBBYX_HOME'] = saved;
  rmSync(home, { recursive: true, force: true });
});

function seed(fn: (s: ClientChannelStore) => void): void {
  const s = new ClientChannelStore(channelStorePath(NET));
  const add = (aa: string, baseAa?: string) =>
    s.add({
      network: NET.caip2,
      aa,
      payTo: seller,
      asset: 'base',
      timeout: 3600,
      salt: 's',
      openedUnit: null,
      funded: true,
      ...(baseAa ? { baseAa } : {}),
    });
  add(AA);
  add(OLD_AA, LEGACY_CHANNEL_BASE_AAS[0]);
  fn(s);
  s.close();
}

let aasByBaseAas: unknown[] = [];

async function run(sub: string, target?: string, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const client = offlineComposer(addressOf(key));
  Object.assign((client as unknown as { api: object }).api, {
    getAaStateVars: hub.client.api.getAaStateVars,
    postJoint: hub.client.api.postJoint,
    getAasByBaseAas: async () => aasByBaseAas,
  });
  const code = await channelCommand(
    { sub, target, ...extra },
    {
      network: NET,
      client,
      privateKey: key,
      logger: silentLogger(),
      out: (s = '') => lines.push(s),
    },
  ).catch((err: unknown) => {
    output = lines.join('\n');
    throw err;
  });
  return { code, out: lines.join('\n') };
}

/** What a failed run printed. */
let output = '';

describe('obbyx channel', () => {
  it('list and status flag legacy channels and suggest closing them', async () => {
    seed(() => undefined);
    const list = await run('list');
    expect(list.out).toMatch(new RegExp(`${OLD_AA}.*legacy base AA`));
    expect(list.out).toContain('close them with: obbyx channel close');
    hub.aaVars.set(OLD_AA, { period: 1, balanceB: 5 });
    expect((await run('status', OLD_AA)).out).toContain('retired base AA');
  });

  it('status shows the payment to retry for a pending voucher', async () => {
    seed((s) => {
      s.setPending(AA, {
        binding: 'a'.repeat(64),
        period: 1,
        amountSpent: '100',
        signedPackage: {},
        paymentHeader: 'HDR',
      });
    });
    const status = await run('status', AA);
    expect(status.out).toContain('--payment HDR');
    expect(status.out).toContain('close the channel');
  });

  it('close declares the highest signed amount even with a pending voucher', async () => {
    seed((s) => {
      s.setPending(AA, {
        binding: 'a'.repeat(64),
        period: 1,
        amountSpent: '700',
        signedPackage: {},
      });
    });
    const r = await run('close', AA);
    expect(r.out).toContain('Close requested for period 1, declaring 0.0000007 GBYTE');
    expect(r.out).toContain('No more payments');
  });

  it("the seller's pending close: close tells to confirm (nothing sent), confirm works at once", async () => {
    seed(() => undefined);
    hub.aaVars.set(AA, { period: 4, close_initiated_by: 'A', close_start_ts: 1 });
    const r = await run('close', AA);
    expect(r.out).toContain('The seller already started closing period 4');
    expect(r.out).toContain(`obbyx channel confirm ${AA}`);
    expect(hub.calls['postJoint']).toBeUndefined();
    expect((await run('confirm', AA)).out).toContain('Close confirmed for period 4');
  });

  it('our own close: confirm explains the wait', async () => {
    seed(() => undefined);
    hub.aaVars.set(AA, {
      period: 1,
      close_initiated_by: 'B',
      close_start_ts: Math.floor(Date.now() / 1000),
    });
    await expect(run('confirm', AA)).rejects.toMatchObject({ code: 'too_early' });
  });

  it('deposit is refused while a close is pending', async () => {
    seed(() => undefined);
    hub.aaVars.set(AA, { period: 1, close_initiated_by: 'A', close_start_ts: 1 });
    await expect(run('deposit', AA, { amount: '0.001' })).rejects.toMatchObject({
      code: 'channel_closing',
    });
  });

  it('recover warns, and closing a recovered channel needs --declare or --force', async () => {
    const me = addressOf(key);
    const params = { addressA: seller, addressB: me, asset: 'base', salt: 'lost', timeout: 3600 };
    const aa = channelAddress(params, CHANNEL_BASE_AA);
    aasByBaseAas = [{ address: aa, definition: channelDefinition(params, CHANNEL_BASE_AA) }];
    hub.aaVars.set(aa, { period: 2, balanceB: 50_000 });
    const rec = await run('recover');
    expect(rec.out).toContain(`Recovered ${aa}`);
    expect(rec.out).toContain('needs --declare');
    expect((await run('status', aa)).out).toContain('uncertain: recovered from the chain');

    await expect(run('close', aa)).rejects.toMatchObject({ code: 'max_signed_uncertain' });
    expect(output).toContain(`WARNING: channel ${aa} was recovered from the chain`);
    expect(output).toContain('--declare <GBYTE>');
    expect(hub.calls['postJoint']).toBeUndefined();

    const forced = await run('close', aa, { force: true });
    expect(forced.out).toContain('Close requested for period 2, declaring 0 GBYTE');
    expect(forced.out).toContain('WARNING: --force');
    aasByBaseAas = [];
  });

  it('a rejected close says to run close again, which sends it without --resend', async () => {
    seed(() => undefined);
    hub.post = 'reject';
    await expect(run('close', AA)).rejects.toMatchObject({ code: 'broadcast_rejected' });
    expect(output).toContain(`obbyx channel close ${AA}\` again`);
    expect((await run('status', AA)).out).toContain('rejected by the hub');
    hub.post = 'accept';
    expect((await run('close', AA)).out).toContain('Close requested for period 1');
    const again = (await run('close', AA)).out;
    expect(again).toContain('already sent (accepted by the hub)');
    expect(again).toContain('the chain shows no close pending for period 1. Nothing was sent now.');
    expect(again).toContain(`obbyx channel close ${AA} --resend`);
    const raised = await run('close', AA, { declare: '0.000001' });
    expect(raised.out).toContain('declaring 0.000001 GBYTE');
    expect(raised.out).toContain('whichever lands first');
  });
});
