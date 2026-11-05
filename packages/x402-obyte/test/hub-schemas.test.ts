import { describe, expect, it } from 'vitest';
import { parseBalances } from '../src/hub/schemas.js';

describe('parseBalances (light/get_balances)', () => {
  const A = 'AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6';

  it('reads every asset of the address as bigint', () => {
    expect(
      parseBalances({ [A]: { base: { stable: 5, pending: 2 }, X: { stable: 1, pending: 0 } } }, A),
    ).toEqual({ base: { stable: 5n, pending: 2n }, X: { stable: 1n, pending: 0n } });
  });

  it('an address without funds has no balances', () => {
    expect(parseBalances({}, A)).toEqual({});
  });

  it('a malformed answer is undefined (fail closed), never half-read', () => {
    expect(parseBalances({ [A]: { base: { stable: -1, pending: 0 } } }, A)).toBeUndefined();
    expect(parseBalances({ [A]: { base: { stable: '5', pending: 0 } } }, A)).toBeUndefined();
    expect(parseBalances('error', A)).toBeUndefined();
  });
});
