import { describe, expect, it } from 'vitest';
import { bindingsEqual, computeBinding, sha256Hex } from '../src/binding/binding.js';

/** Test vector published in docs/specs/scheme_exact_obyte.md (Binding). */
const VECTOR = {
  secret: 's'.repeat(32),
  input: {
    sellerId: 'api',
    scheme: 'exact',
    quoteId: 'quote-0001',
    validUntil: 1790000310,
    method: 'GET',
    url: '/api/x',
    bodyHash: sha256Hex(''),
    network: 'obyte:testnet',
    asset: 'base',
    amount: '20000',
    payTo: 'AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6',
  },
  binding: 'd0a417add6f72db9139e06a23107f8d7494d7b6f92d81edd0d949ec30a7ad698',
};

describe('binding', () => {
  it('matches the published test vector', () => {
    expect(computeBinding(VECTOR.secret, VECTOR.input)).toBe(VECTOR.binding);
  });

  it('changes with any field of the operation or the offer; method case does not matter', () => {
    const base = computeBinding(VECTOR.secret, VECTOR.input);
    expect(computeBinding(VECTOR.secret, { ...VECTOR.input, method: 'get' })).toBe(base);
    for (const [k, v] of Object.entries({
      url: '/api/y',
      amount: '20001',
      payTo: 'X'.repeat(32),
      quoteId: 'quote-0002',
      scheme: 'batch-settlement',
    })) {
      expect(computeBinding(VECTOR.secret, { ...VECTOR.input, [k]: v })).not.toBe(base);
    }
    expect(computeBinding('t'.repeat(32), VECTOR.input)).not.toBe(base);
  });

  it('compares in constant time and handles different lengths', () => {
    expect(bindingsEqual(VECTOR.binding, VECTOR.binding)).toBe(true);
    expect(bindingsEqual(VECTOR.binding, VECTOR.binding.slice(1))).toBe(false);
  });
});
