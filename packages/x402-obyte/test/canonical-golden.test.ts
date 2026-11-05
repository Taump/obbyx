import obyte from 'obyte';
import { describe, expect, it } from 'vitest';
import { canonical } from '../src/exact/requirements.js';
import { computeBinding, sha256Hex } from '../src/binding/binding.js';

/**
 * Golden vectors: `canonical()` feeds the binding HMAC, channel package hashes
 * (stored in the facilitator and watcher databases) and request-body hashes.
 * Its output must never change silently.
 */
const bindingInput = {
  sellerId: 'api-1',
  scheme: 'exact',
  quoteId: 'quote-0001',
  validUntil: 1790000310,
  method: 'post',
  url: '/api/answer?x=1',
  bodyHash: sha256Hex(''),
  network: 'obyte:testnet',
  asset: 'base',
  amount: '20000',
  payTo: 'AIC2WZ63XXXXXXXXXXXXXXXXXXXXXXXX',
};
const voucher = () =>
  obyte.utils.signMessage(
    {
      aa_address: 'A'.repeat(32),
      period: 1,
      amount_spent: 300,
      payment_amount: 100,
      binding: 'f0'.repeat(32),
    },
    { privateKey: Buffer.alloc(32, 7), testnet: true },
  );

describe('canonical() golden vectors', () => {
  // Values computed with the previous (localeCompare) ordering: the switch to
  // code-unit ordering must not change any hash already stored or signed.
  it('the binding HMAC is unchanged', () => {
    expect(computeBinding('s'.repeat(32), bindingInput)).toBe(
      '1663c2c13ed0401a8a24b05f6fd8cfbdc602b1e81fac8083af0ac42909f8e2a3',
    );
  });

  it('the channel package hash is unchanged', () => {
    expect(sha256Hex(canonical(voucher()))).toBe(
      'e714de44faf0bc344cf9edba8478d9f20686d86d3eabf4adf13bc81d6835890e',
    );
  });

  it('sorts keys by UTF-16 code units, independent of the locale / ICU', () => {
    expect(canonical({ b: 1, a: { d: 1, c: 2 }, aa_address: 1, aaa: 2 })).toBe(
      '{"a":{"c":2,"d":1},"aa_address":1,"aaa":2,"b":1}',
    );
    // uppercase before lowercase (localeCompare would put "a" first)
    expect(canonical({ a: 1, Z: 2, é: 3, _: 4 })).toBe('{"Z":2,"_":4,"a":1,"é":3}');
  });
});
