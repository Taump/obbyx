import { ObbyxError } from '@obbyx/obyte';

/**
 * Spending limits for a paying client (agents, services).
 *
 * - `perCall`: the most one request may cost, per asset.
 * - `total`: the most all requests may cost together, per asset.
 *
 * Amounts are RESERVED before a payment is signed (atomically: the event loop
 * runs reserve() to completion), so concurrent calls can never overshoot the
 * total. A reservation is then:
 * - `spent` when the seller confirmed the payment,
 * - `released` when the payment was definitely not made,
 * - left in place when the outcome is unknown (invariant I7): the budget never
 *   under-counts a payment that may still settle.
 */
export interface BudgetLimits {
  readonly perCall?: ReadonlyMap<string, bigint>;
  readonly total?: ReadonlyMap<string, bigint>;
}

export interface BudgetReservation {
  readonly id: number;
  readonly asset: string;
  readonly amount: bigint;
}

export class BudgetExceededError extends ObbyxError {
  constructor(message: string, details: Record<string, unknown>) {
    super('budget_exceeded', message, { details });
  }
}

export class SpendingBudget {
  private readonly spent = new Map<string, bigint>();
  private readonly reserved = new Map<number, BudgetReservation>();
  private nextId = 1;

  constructor(private readonly limits: BudgetLimits) {}

  reserve(asset: string, amount: bigint): BudgetReservation {
    const perCall = this.limits.perCall?.get(asset);
    if (perCall !== undefined && amount > perCall) {
      throw new BudgetExceededError(
        `Price ${amount} exceeds the per-call limit ${perCall} (${asset})`,
        {
          asset,
          amount: amount.toString(),
          perCall: perCall.toString(),
        },
      );
    }
    const total = this.limits.total?.get(asset);
    const committed = this.used(asset);
    if (total !== undefined && committed + amount > total) {
      throw new BudgetExceededError(
        `Paying ${amount} would exceed the total budget ${total} (${asset}); already used or reserved: ${committed}`,
        { asset, amount: amount.toString(), total: total.toString(), used: committed.toString() },
      );
    }
    const reservation = { id: this.nextId++, asset, amount };
    this.reserved.set(reservation.id, reservation);
    return reservation;
  }

  /** The payment settled: the amount is spent. */
  spend(r: BudgetReservation): void {
    if (!this.reserved.delete(r.id)) return;
    this.spent.set(r.asset, (this.spent.get(r.asset) ?? 0n) + r.amount);
  }

  /** The payment was definitely not made: give the amount back. */
  release(r: BudgetReservation): void {
    this.reserved.delete(r.id);
  }

  /** Spent + reserved (unknown outcomes included) for an asset. */
  used(asset: string): bigint {
    let sum = this.spent.get(asset) ?? 0n;
    for (const r of this.reserved.values()) if (r.asset === asset) sum += r.amount;
    return sum;
  }

  remaining(asset: string): bigint | undefined {
    const total = this.limits.total?.get(asset);
    return total === undefined ? undefined : total - this.used(asset);
  }
}
