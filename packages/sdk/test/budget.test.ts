import { describe, expect, it } from 'vitest';
import { BudgetExceededError, SpendingBudget } from '../src/client/budget.js';

const budget = () =>
  new SpendingBudget({ perCall: new Map([['base', 100n]]), total: new Map([['base', 250n]]) });

describe('SpendingBudget', () => {
  it('enforces the per-call limit', () => {
    expect(() => budget().reserve('base', 101n)).toThrow(BudgetExceededError);
  });

  it('reservations count against the total immediately (no overshoot under concurrency)', () => {
    const b = budget();
    b.reserve('base', 100n);
    b.reserve('base', 100n);
    expect(() => b.reserve('base', 100n)).toThrow(/total budget/);
    expect(b.remaining('base')).toBe(50n);
  });

  it('spent stays counted, released goes back, unknown outcomes stay reserved', () => {
    const b = budget();
    const a = b.reserve('base', 100n);
    const c = b.reserve('base', 100n);
    b.spend(a);
    b.release(c);
    expect(b.used('base')).toBe(100n);
    b.reserve('base', 100n); // outcome unknown: never released
    expect(b.used('base')).toBe(200n);
    b.spend(a); // idempotent
    expect(b.used('base')).toBe(200n);
  });

  it('limits are per asset', () => {
    const b = budget();
    expect(b.reserve('Z'.repeat(43) + '=', 10_000n).amount).toBe(10_000n);
    expect(b.remaining('Z'.repeat(43) + '=')).toBeUndefined();
  });
});
