import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ExactExpectation,
  EXACT_REASONS as R,
  validateExactUnit,
} from '../src/unit/exact-unit.js';
import { OBYTE_NETWORKS } from '../src/core/networks.js';
import {
  HASH_A,
  HASH_B,
  addressOf,
  composeTestUnit,
  refinalize,
  sigDefinitionOf,
  testKey,
} from './helpers.js';

const testnet = OBYTE_NETWORKS.testnet;
const payer = testKey('payer');
const seller = addressOf(testKey('seller'));
const stranger = addressOf(testKey('stranger'));
const ASSET = 'Z'.repeat(43) + '=';
const BINDING = 'f0'.repeat(32);
const DATA = { app: 'data', payload: { x402: { binding: BINDING, quoteId: 'q-1' } } };

/** Units composed by obyte.js `client.compose.message` (offline, explicit coins). */
function bytesUnit(includeDefinition = true, amount = 20_000) {
  return composeTestUnit({
    key: payer,
    includeDefinition,
    coins: { base: [{ unit: HASH_A, messageIndex: 0, outputIndex: 1, amount: 1_000_000 }] },
    messages: [{ app: 'payment', payload: { outputs: [{ address: seller, amount }] } }, DATA],
  });
}

const units: Record<string, Record<string, unknown>> = {};
beforeAll(async () => {
  units['base'] = await bytesUnit();
  units['wrongAmount'] = await bytesUnit(true, 19_999);
  units['noDefinition'] = await bytesUnit(false);
  units['asset'] = await composeTestUnit({
    key: payer,
    coins: {
      base: [{ unit: HASH_A, messageIndex: 0, outputIndex: 0, amount: 50_000 }],
      [ASSET]: [{ unit: HASH_B, messageIndex: 1, outputIndex: 0, amount: 700 }],
    },
    messages: [
      { app: 'payment', payload: { asset: ASSET, outputs: [{ address: seller, amount: 700 }] } },
      DATA,
    ],
  });
});

const expectation: ExactExpectation = {
  network: testnet,
  payTo: seller,
  asset: 'base',
  amount: 20_000n,
  binding: BINDING,
  quoteId: 'q-1',
};

type U = Record<string, any>;
const payment = (u: U) => u['messages'].find((m: U) => m.app === 'payment' && !m.payload.asset);

describe('validateExactUnit — accepted profile', () => {
  it('accepts a unit composed by obyte.js and reports facts for ledger checks', () => {
    const unit = units['base']!;
    const res = validateExactUnit(unit, expectation);
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    expect(res.value.payer).toBe(addressOf(payer));
    expect(res.value.unitHash).toBe(unit['unit']);
    expect(res.value.inputs).toEqual([
      { asset: 'base', unit: HASH_A, messageIndex: 0, outputIndex: 1 },
    ]);
    expect(res.value.definitionFromLedger).toBe(false);
    // inputs = outputs + fees (tps fee included)
    const { headers, payload } = res.value.commissions;
    expect(res.value.outputTotals['base']! + BigInt(headers + payload + 10)).toBe(1_000_000n);
  });

  it('accepts an asset payment with a bytes message for fees', () => {
    const res = validateExactUnit(units['asset'], { ...expectation, asset: ASSET, amount: 700n });
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
  });

  it('asks for the definition when it is not embedded, then accepts it from the ledger', () => {
    const unit = units['noDefinition'];
    expect(validateExactUnit(unit, expectation)).toMatchObject({
      ok: false,
      reason: R.definitionRequired,
    });
    const res = validateExactUnit(unit, expectation, { authorDefinition: sigDefinitionOf(payer) });
    expect(res).toMatchObject({ ok: true, value: { definitionFromLedger: true } });
    expect(
      validateExactUnit(unit, expectation, { authorDefinition: sigDefinitionOf(testKey('other')) }),
    ).toMatchObject({ ok: false, reason: R.definition });
  });
});

describe('validateExactUnit — every check holds on its own', () => {
  const cases: [string, (u: U) => U, string, Partial<ExactExpectation>?][] = [
    ['wrong amount (re-signed by payer)', () => structuredClone(units['wrongAmount']!), R.amount],
    ['binding of another operation', (u) => u, R.binding, { binding: 'aa'.repeat(32) }],
    ['quote of another offer', (u) => u, R.binding, { quoteId: 'q-2' }],
    ['other network', (u) => u, R.network, { network: OBYTE_NETWORKS.livenet }],
    ['other recipient expected', (u) => u, R.recipient, { payTo: stranger }],
    ['asset expected but bytes paid', (u) => u, R.asset, { asset: ASSET }],
    [
      'payer is a facilitator address',
      (u) => u,
      R.payer,
      { facilitatorAddresses: [addressOf(payer)] },
    ],
    ['payer pays itself', (u) => u, R.payer, { payTo: addressOf(payer) }],
    ['oversized', (u) => u, R.tooLarge, { maxUnitBytes: 100 }],
    [
      'payload changed without updating payload_hash',
      (u) => {
        payment(u).payload.outputs[0].amount += 1;
        return u;
      },
      R.payloadHash,
    ],
    [
      'payload with a null value (obyte.js cannot hash it): rejected, never thrown',
      (u) => {
        u.messages.find((m: U) => m.app === 'data').payload.x402.binding = null;
        return u;
      },
      R.payloadHash,
    ],
    [
      'payload changed with new payload_hash but old unit hash',
      (u) => {
        payment(u).payload.outputs.find((o: U) => o.address !== seller).amount -= 1;
        return refinalize(u, payer, { sign: false, unitHash: false, commissions: false });
      },
      R.unitHash,
    ],
    [
      'content changed and re-hashed without the payer key',
      (u) => {
        payment(u).payload.outputs.find((o: U) => o.address !== seller).amount -= 1;
        return refinalize(u, payer, { sign: false, commissions: false });
      },
      R.signature,
    ],
    ['signed by another key', (u) => refinalize(u, testKey('mallory')), R.signature],
    [
      'third-party output',
      (u) => {
        const outs = payment(u).payload.outputs;
        outs.find((o: U) => o.address !== seller).amount -= 100;
        outs.push({ address: stranger, amount: 100 });
        outs.sort((a: U, b: U) => (a.address < b.address ? -1 : 1));
        return refinalize(u, payer);
      },
      R.recipient,
    ],
    [
      'two outputs to payTo',
      (u) => {
        const outs = payment(u).payload.outputs;
        const s = outs.find((o: U) => o.address === seller);
        s.amount = 10_000;
        outs.push({ address: seller, amount: 10_000 });
        outs.sort((a: U, b: U) =>
          a.address < b.address ? -1 : a.address > b.address ? 1 : a.amount - b.amount,
        );
        return refinalize(u, payer);
      },
      R.unsupported, // duplicate (address, amount) pair is outside the profile
    ],
    [
      'unsorted outputs',
      (u) => {
        payment(u).payload.outputs.reverse();
        return refinalize(u, payer);
      },
      R.unsupported,
    ],
    ['stripped unit (content_hash)', (u) => ({ ...u, content_hash: HASH_A }), R.unsupported],
    [
      'second data message',
      (u) => {
        u['messages'].push({
          app: 'data',
          payload_location: 'inline',
          payload_hash: '',
          payload: { a: 1 },
        });
        return refinalize(u, payer);
      },
      R.binding,
    ],
    [
      'other app message',
      (u) => {
        u['messages'].push({
          app: 'text',
          payload_location: 'inline',
          payload_hash: '',
          payload: 'hi',
        });
        return refinalize(u, payer);
      },
      R.unsupported,
    ],
    [
      'issue input instead of transfer',
      (u) => {
        payment(u).payload.inputs[0] = { type: 'issue', serial_number: 1, amount: 1_000_000 };
        return refinalize(u, payer);
      },
      R.unsupported,
    ],
    [
      'wrong commissions',
      (u) => {
        u['headers_commission'] += 1;
        return refinalize(u, payer, { commissions: false });
      },
      R.commissions,
    ],
    [
      'multisig author definition',
      (u) => {
        u['authors'][0].definition = ['or', [['sig', { pubkey: 'A'.repeat(44) }]]];
        return refinalize(u, payer);
      },
      R.definition,
    ],
  ];

  it.each(cases)('%s', (_name, mutate, reason, override) => {
    const unit = mutate(structuredClone(units['base']!) as U);
    const res = validateExactUnit(unit, { ...expectation, ...override });
    expect(res).toMatchObject({ ok: false, reason });
  });

  it('never throws on garbage input', () => {
    for (const junk of [null, 1, 'x', [], {}, { messages: 'x' }, { authors: [{}], messages: [] }]) {
      expect(validateExactUnit(junk, expectation).ok).toBe(false);
    }
  });
});
