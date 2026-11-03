import { describe, expect, it } from 'vitest';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { decidePaymentId } from '../src/seller/payment-identifier.js';

describe('ConsumedProofsStore', () => {
  it('one proof, one operation: transitions are compare-and-set', () => {
    const s = new ConsumedProofsStore(':memory:', () => 100);
    expect(s.begin('k', 'b1')).toMatchObject({ created: true, record: { state: 'settling' } });
    expect(s.begin('k', 'b2')).toMatchObject({ created: false, record: { binding: 'b1' } });
    expect(s.transition('k', 'settling', 'paid_not_served', { paymentResponse: 'P' })).toBe(true);
    expect(s.transition('k', 'paid_not_served', 'serving')).toBe(true);
    expect(s.transition('k', 'paid_not_served', 'serving')).toBe(false); // second request loses
  });

  it('recovers a proof stuck in serving only after the lease, to the right state', () => {
    let now = 100;
    const s = new ConsumedProofsStore(':memory:', () => now);
    s.begin('paid', 'b');
    s.transition('paid', 'settling', 'paid_not_served', { paymentResponse: 'P' });
    s.transition('paid', 'paid_not_served', 'serving');
    s.begin('auth', 'b');
    s.transition('auth', 'settling', 'serving');

    expect(s.reclaimStale('paid', 300)).toBe(false); // still within the lease
    now = 401;
    expect(s.reclaimStale('paid', 300)).toBe(true);
    expect(s.get('paid')?.state).toBe('paid_not_served'); // settled: serve without paying again
    expect(s.reclaimStale('paid', 300)).toBe(false); // one winner
    expect(s.reclaimStale('auth', 300)).toBe(true);
    expect(s.get('auth')?.state).toBe('settling'); // nothing settled yet
  });
});

describe('payment-identifier decisions', () => {
  it('concurrent retries with different payments after a failure: exactly one proceeds', () => {
    const s = new ConsumedProofsStore(':memory:');
    const input = (proofKey: string) => ({
      paymentId: 'pay_0123456789abcdef',
      required: false,
      scopeId: (id: string) => `seller:${id}`,
      fingerprint: 'op',
      proofKey,
    });
    s.begin('p1', 'b'); // contract: the proof row exists before the decision
    expect(decidePaymentId(s, input('p1'))).toEqual({ kind: 'proceed' });
    s.transition('p1', 'settling', 'failed');
    s.begin('p2', 'b');
    s.begin('p3', 'b');
    const a = decidePaymentId(s, input('p2'));
    const b = decidePaymentId(s, input('p3'));
    expect([a.kind, b.kind].sort()).toEqual(['proceed', 'reject']);
    expect(b).toEqual({ kind: 'reject', status: 409, error: 'payment_in_progress' });
  });

  it('validates the id format with zod and enforces required ids', () => {
    const s = new ConsumedProofsStore(':memory:');
    const base = { required: true, scopeId: (id: string) => id, fingerprint: 'op', proofKey: 'p' };
    expect(decidePaymentId(s, { ...base, paymentId: 'invalid' })).toMatchObject({ status: 400 });
    expect(decidePaymentId(s, { ...base, paymentId: undefined })).toMatchObject({
      error: 'payment_identifier_required',
    });
  });
});
