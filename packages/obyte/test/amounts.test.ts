import { describe, expect, it } from 'vitest';
import {
  AmountError,
  MAX_AMOUNT,
  addAmounts,
  formatAmount,
  fromDisplay,
  fromSafeNumber,
  parseAmount,
  subAmounts,
  toDisplay,
  toSafeNumber,
} from '../src/core/amounts.js';

describe('parseAmount', () => {
  it.each(['0', '1', '10000', String(Number.MAX_SAFE_INTEGER)])('accepts %s', (s) => {
    expect(formatAmount(parseAmount(s))).toBe(s);
  });

  it.each(['', '-1', '01', '1.5', '1e3', ' 1', '0x10', String(Number.MAX_SAFE_INTEGER + 1)])(
    'rejects %j',
    (s) => {
      expect(() => parseAmount(s)).toThrow(AmountError);
    },
  );
});

describe('number boundary', () => {
  it('round-trips the maximum safe integer', () => {
    expect(toSafeNumber(MAX_AMOUNT)).toBe(Number.MAX_SAFE_INTEGER);
    expect(fromSafeNumber(Number.MAX_SAFE_INTEGER)).toBe(MAX_AMOUNT);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('rejects number %s', (n) => {
    expect(() => fromSafeNumber(n)).toThrow(AmountError);
  });
});

describe('arithmetic', () => {
  it('detects overflow and negative results instead of wrapping', () => {
    expect(() => addAmounts(MAX_AMOUNT, 1n)).toThrow(AmountError);
    expect(() => subAmounts(1n, 2n)).toThrow(AmountError);
    expect(subAmounts(20n, 10n)).toBe(10n);
  });
});

describe('display conversion (no floats)', () => {
  it.each([
    ['1', 9, 1_000_000_000n],
    ['0.000000001', 9, 1n],
    ['0.1', 9, 100_000_000n],
    ['12.34', 2, 1234n],
    ['7', 0, 7n],
  ])('fromDisplay(%s, %d) = %s', (input, decimals, expected) => {
    expect(fromDisplay(input, decimals)).toBe(expected);
    expect(toDisplay(expected, decimals)).toBe(input);
  });

  it('a classic float pitfall stays exact: 0.1 + 0.2', () => {
    expect(addAmounts(fromDisplay('0.1', 9), fromDisplay('0.2', 9))).toBe(fromDisplay('0.3', 9));
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => fromDisplay('0.0000000001', 9)).toThrow(AmountError);
    expect(() => fromDisplay('1.', 9)).toThrow(AmountError);
    expect(() => fromDisplay('1', 19)).toThrow(AmountError);
  });
});
