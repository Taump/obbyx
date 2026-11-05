import obyte from 'obyte';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CoinReservations,
  ReservingComposer,
  selectCoins,
  unspentOutputs,
} from '../src/coins/index.js';
import {
  HASH_A,
  HASH_B,
  HASH_C,
  addressOf,
  testKey,
  silentLogger,
} from '../../obyte/test/helpers.js';
import { FakeHub } from './fake-hub.js';

const NET = 'obyte:testnet';
const key = testKey('payer');
const me = addressOf(key);
const other = addressOf(testKey('other'));
const seller = addressOf(testKey('seller'));
const silent = silentLogger();
const U = (c: string) => c.repeat(43) + '=';

describe('unspentOutputs / selectCoins', () => {
  const joints = [
    // received from someone else, stable at MCI 10
    {
      unit: {
        unit: U('D'),
        main_chain_index: 10,
        authors: [{ address: other }],
        messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount: 500 }] } }],
      },
      ball: 'b',
    },
    // received, NOT stable → not spendable
    {
      unit: {
        unit: U('E'),
        main_chain_index: null,
        authors: [{ address: other }],
        messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount: 900 }] } }],
      },
    },
    // received, stable but after the last ball → not spendable
    {
      unit: {
        unit: U('F'),
        main_chain_index: 99,
        authors: [{ address: other }],
        messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount: 800 }] } }],
      },
      ball: 'b',
    },
    // my own unstable unit: spends D's output? no — spends G; its change is spendable
    {
      unit: {
        unit: U('G'),
        main_chain_index: null,
        authors: [{ address: me }],
        messages: [
          {
            app: 'payment',
            payload: {
              inputs: [{ unit: U('H'), message_index: 0, output_index: 0 }],
              outputs: [
                { address: seller, amount: 5 },
                { address: me, amount: 300 },
              ],
            },
          },
          {
            app: 'payment',
            payload: { asset: 'Z'.repeat(43) + '=', outputs: [{ address: me, amount: 7 }] },
          },
        ],
      },
    },
    // an output that is already spent by G
    {
      unit: {
        unit: U('H'),
        main_chain_index: 5,
        authors: [{ address: other }],
        messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount: 1000 }] } }],
      },
      ball: 'b',
    },
  ];

  it('follows light-wallet rules (others stable ≤ last ball; own unstable ok; spent excluded)', () => {
    const utxos = unspentOutputs(joints, me, 50);
    expect(
      utxos.map((u) => [
        u.unit[0],
        u.messageIndex,
        u.outputIndex,
        u.asset === 'base' ? 'base' : 'Z',
        u.amount,
      ]),
    ).toEqual([
      ['D', 0, 0, 'base', 500n],
      ['G', 0, 1, 'base', 300n],
      ['G', 1, 0, 'Z', 7n],
    ]);
  });

  it('selects largest first and fails when not enough', () => {
    const utxos = unspentOutputs(joints, me, 50);
    expect(selectCoins(utxos, 'base', 600n)?.map((u) => u.amount)).toEqual([500n, 300n]);
    expect(selectCoins(utxos, 'base', 900n)).toBeUndefined();
  });
});

describe('ReservingComposer', () => {
  let hub: FakeHub;
  let reservations: CoinReservations;
  let now: number;

  const coin = (c: string, amount: number) => ({
    unit: U(c),
    main_chain_index: 1,
    authors: [{ address: other }],
    messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount }] } }],
  });

  function composerClient() {
    const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
    c.close();
    const any = c as unknown as { cachedWitnesses: string[]; api: Record<string, unknown> };
    Object.assign(any.api, hub.client.api);
    any.cachedWitnesses = ['W'.repeat(32)];
    any.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
      parent_units: [HASH_A],
      last_stable_mc_ball: HASH_B,
      last_stable_mc_ball_unit: HASH_C,
      last_stable_mc_ball_mci: 100,
      timestamp: 1_790_000_000,
      tps_fee: 10,
    });
    any.api['getDefinitionForAddress'] = async () => ({ definition_chash: me, is_stable: true });
    // history with ball → stable coins of another author
    any.api['getHistory'] = async () => ({
      joints: hub.history.map((unit) => ({ unit, ball: 'b' })),
    });
    return c;
  }

  beforeEach(() => {
    hub = new FakeHub();
    hub.history.push(coin('P', 50_000), coin('Q', 50_000));
    now = 1_790_000_000;
    reservations = new CoinReservations(':memory:', () => now);
  });

  const pay = (client: obyte.Client, composer: ReservingComposer) =>
    composer.compose(
      () =>
        client.compose.message(
          'multi',
          [
            { app: 'payment', payload: { outputs: [{ address: seller, amount: 20_000 }] } },
          ] as never,
          {
            privateKey: key,
            testnet: true,
          },
        ) as unknown as Promise<Record<string, unknown>>,
    );
  const inputsOf = (u: Record<string, unknown>) =>
    (u['messages'] as { app: string; payload: { inputs?: { unit: string }[] } }[])
      .flatMap((m) => m.payload.inputs ?? [])
      .map((i) => i.unit);

  it('concurrent payments from one wallet never pick the same coins', async () => {
    const client = composerClient();
    const composer = new ReservingComposer({
      client,
      network: NET,
      address: me,
      reservations,
      logger: silent,
      now: () => now,
    });
    const [a, b] = await Promise.all([pay(client, composer), pay(client, composer)]);
    const ia = inputsOf(a);
    const ib = inputsOf(b);
    expect(ia).toHaveLength(1);
    expect(ib).toHaveLength(1);
    expect(ia[0]).not.toBe(ib[0]);
    // a third payment has no free coin while both are unpublished
    await expect(pay(client, composer)).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('a unit seen on the ledger ends its reservation; an unpublished one is released only after the window', async () => {
    const client = composerClient();
    const composer = new ReservingComposer({
      client,
      network: NET,
      address: me,
      reservations,
      logger: silent,
      releaseAfterSeconds: 600,
      now: () => now,
    });
    const a = await pay(client, composer);
    const b = await pay(client, composer);
    // a becomes known to the hub → its reservation ends at the next sweep
    hub.joints.set(String(a['unit']), a);
    await composer.sweep();
    expect(reservations.boundUnits(NET).map((r) => r.unit)).toEqual([b['unit']]);
    // b was never published: still reserved before the window …
    now += 599;
    await composer.sweep();
    expect(reservations.boundUnits(NET)).toHaveLength(1);
    // … and released after it
    now += 2;
    await composer.sweep();
    expect(reservations.boundUnits(NET)).toHaveLength(0);
  });

  it('a long-lived offer keeps the inputs reserved until holdUntil, even after releaseAfterSeconds', async () => {
    const client = composerClient();
    const composer = new ReservingComposer({
      client,
      network: NET,
      address: me,
      reservations,
      logger: silent,
      releaseAfterSeconds: 600,
      now: () => now,
    });
    const start = now;
    await composer.compose(
      () =>
        client.compose.message(
          'multi',
          [
            { app: 'payment', payload: { outputs: [{ address: seller, amount: 20_000 }] } },
          ] as never,
          { privateKey: key, testnet: true },
        ) as unknown as Promise<{ unit: string }>,
      { holdUntil: start + 5000 },
    );
    now = start + 601; // past releaseAfterSeconds, before holdUntil
    await composer.sweep();
    expect(reservations.boundUnits(NET)).toHaveLength(1);
    now = start + 5001;
    await composer.sweep();
    expect(reservations.boundUnits(NET)).toHaveLength(0);
  });

  it('keeps reservations when the hub cannot be asked (fail-safe) and releases them when compose fails', async () => {
    const client = composerClient();
    const composer = new ReservingComposer({
      client,
      network: NET,
      address: me,
      reservations,
      logger: silent,
      hubTimeoutMs: 50,
      now: () => now,
    });
    await pay(client, composer);
    hub.down = true;
    now += 10_000;
    await composer.sweep();
    expect(reservations.boundUnits(NET)).toHaveLength(1);
    hub.down = false;

    const failing = composer.compose(async () => {
      await (
        client.api as unknown as { pickDivisibleCoinsForAmount: (p: unknown) => Promise<unknown> }
      ).pickDivisibleCoinsForAmount({
        addresses: [me],
        last_ball_mci: 100,
        amount: 1000,
      });
      throw new Error('signing failed');
    });
    await expect(failing).rejects.toThrow('signing failed');
    expect(reservations.rows().filter((r) => r.payment_unit === null)).toHaveLength(0);
  });
});

describe('ExactObyteClient fee cap', () => {
  it('refuses a unit with fees above maxFee and releases its inputs immediately', async () => {
    const { ExactObyteClient } = await import('../src/exact/client.js');
    const hub = new FakeHub();
    hub.history.push({
      unit: U('P'),
      main_chain_index: 1,
      authors: [{ address: other }],
      messages: [{ app: 'payment', payload: { outputs: [{ address: me, amount: 50_000 }] } }],
    });
    const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
    c.close();
    const any = c as unknown as { cachedWitnesses: string[]; api: Record<string, unknown> };
    Object.assign(any.api, hub.client.api);
    any.cachedWitnesses = ['W'.repeat(32)];
    any.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
      parent_units: [HASH_A],
      last_stable_mc_ball: HASH_B,
      last_stable_mc_ball_unit: HASH_C,
      last_stable_mc_ball_mci: 100,
      timestamp: Math.floor(Date.now() / 1000),
      tps_fee: 10,
    });
    any.api['getDefinitionForAddress'] = async () => ({ definition_chash: me, is_stable: true });
    any.api['getHistory'] = async () => ({
      joints: hub.history.map((unit) => ({ unit, ball: 'b' })),
    });
    const reservations = new CoinReservations(':memory:');
    const composer = new ReservingComposer({
      client: c,
      network: NET,
      address: me,
      reservations,
      logger: silent,
    });
    const client = new ExactObyteClient({
      client: c,
      network: NET,
      privateKey: key,
      logger: silent,
      composer,
      maxFee: 100n,
    });
    const req = {
      scheme: 'exact',
      network: NET,
      asset: 'base',
      amount: '20000',
      payTo: seller,
      maxTimeoutSeconds: 60,
      extra: {
        binding: 'f0'.repeat(32),
        quoteId: 'quote-0001',
        validUntil: Math.floor(Date.now() / 1000) + 300,
      },
    } as const;
    await expect(client.createPaymentPayload(2, req)).rejects.toMatchObject({
      code: 'fee_over_limit',
    });
    expect(reservations.rows()).toHaveLength(0);
  });
});
