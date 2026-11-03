import { ObbyxError } from './errors.js';

/**
 * Amounts are always integers in the asset's smallest units (invariant I5).
 *
 * - On the wire (x402 JSON) they are decimal strings.
 * - Inside obbyx they are `bigint`.
 * - They are converted to `number` only at the boundary with libraries that
 *   require it (ocore, obyte.js, AA formulas), via {@link toSafeNumber}.
 * - Prices are never computed with floating point.
 */
export type Amount = bigint;

/** Largest amount accepted anywhere: every amount must round-trip through JS `number`. */
export const MAX_AMOUNT: Amount = BigInt(Number.MAX_SAFE_INTEGER);

const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const DISPLAY_RE = /^(0|[1-9][0-9]*)(\.([0-9]+))?$/;
const MAX_DECIMALS = 18;

export class AmountError extends ObbyxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_amount', message, details === undefined ? {} : { details });
  }
}

function assertInRange(value: Amount, input: unknown): Amount {
  if (value < 0n || value > MAX_AMOUNT) {
    throw new AmountError('Amount is out of range', { input: String(input) });
  }
  return value;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError('Invalid number of decimals', { decimals });
  }
}

/** Parses an atomic amount from its canonical decimal-string form ("0", "1500"). */
export function parseAmount(input: string): Amount {
  if (typeof input !== 'string' || !AMOUNT_RE.test(input)) {
    throw new AmountError('Amount must be a non-negative integer string without leading zeros', {
      input: String(input),
    });
  }
  return assertInRange(BigInt(input), input);
}

/** Accepts a safe non-negative integer `number` (e.g. from ocore) and returns a bigint. */
export function fromSafeNumber(input: number): Amount {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new AmountError('Amount must be a non-negative safe integer', { input });
  }
  return BigInt(input);
}

/** Canonical wire form. */
export function formatAmount(value: Amount): string {
  return assertInRange(value, value).toString();
}

/** Converts for libraries that only accept `number`; throws instead of losing precision. */
export function toSafeNumber(value: Amount): number {
  return Number(assertInRange(value, value));
}

export function addAmounts(a: Amount, b: Amount): Amount {
  return assertInRange(a + b, `${a}+${b}`);
}

/** Subtraction that never goes below zero silently. */
export function subAmounts(a: Amount, b: Amount): Amount {
  if (b > a) {
    throw new AmountError('Amount subtraction would be negative', {
      a: a.toString(),
      b: b.toString(),
    });
  }
  return a - b;
}

/**
 * Converts a human-readable amount ("0.25") into atomic units.
 * Rejects more fractional digits than the asset supports instead of rounding.
 */
export function fromDisplay(input: string, decimals: number): Amount {
  assertDecimals(decimals);
  const match = typeof input === 'string' ? DISPLAY_RE.exec(input) : null;
  if (!match) {
    throw new AmountError('Display amount must look like "12" or "12.34"', {
      input: String(input),
    });
  }
  const whole = match[1] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) {
    throw new AmountError('Display amount has more fractional digits than the asset allows', {
      input,
      decimals,
    });
  }
  const atomic = BigInt(whole + fraction.padEnd(decimals, '0'));
  return assertInRange(atomic, input);
}

/** Converts atomic units into a human-readable string without floating point. */
export function toDisplay(value: Amount, decimals: number): string {
  assertDecimals(decimals);
  const digits = formatAmount(value);
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
