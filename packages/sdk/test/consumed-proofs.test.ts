import { describe, expect, it } from 'vitest';
import { ConsumedProofsStore } from '../src/seller/consumed-proofs.js';
import { decidePaymentId } from '../src/seller/payment-identifier.js';
import { ObyteExactServer } from '../src/seller/x402-server.js';
import { Writable } from 'node:stream';
import { createLogger } from '@obbyx/obyte/logger';

const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });

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

describe('ObyteExactServer crash recovery', () => {
  it('a payment left in serving by a crashed process is taken over after the lease', async () => {
    let now = 1000;
    const proofs = new ConsumedProofsStore(':memory:', () => now);
    const server = new ObyteExactServer({
      sellerId: 's',
      secret: 'x'.repeat(32),
      proofs,
      logger: silent,
      now: () => now,
    });
    const unit = 'U'.repeat(43) + '=';
    const ctx = {
      paymentPayload: { payload: { unit: { unit } } },
      requirements: { network: 'obyte:testnet' },
    };
    const key = `obyte:testnet:unit:${unit}`;
    proofs.begin(key, 'b');
    const hooks = server.schemeHooks as { onBeforeSettle: (c: unknown) => Promise<unknown> };
    expect(await hooks.onBeforeSettle(ctx)).toBeUndefined(); // claimed: settling → serving
    // the process dies here; a retry within the lease is refused …
    expect(await hooks.onBeforeSettle(ctx)).toMatchObject({
      abort: true,
      reason: 'payment_in_progress',
    });
    now += 301;
    // … and taken over after it
    expect(await hooks.onBeforeSettle(ctx)).toBeUndefined();
  });
});

describe('markSettled', () => {
  it('records a settled payment as paid, also when its row was removed meanwhile; never downgrades served', () => {
    const s = new ConsumedProofsStore(':memory:');
    s.begin('a', 'b');
    expect(s.markSettled('a', 'b', 'P')).toBe('paid_not_served');
    expect(s.markSettled('gone', 'b', 'P')).toBe('paid_not_served'); // row deleted by a concurrent refusal
    expect(s.get('gone')).toMatchObject({ binding: 'b', paymentResponse: 'P' });
    s.transition('a', 'paid_not_served', 'serving');
    s.transition('a', 'serving', 'served', {
      response: { status: 200, headers: {}, body: new Uint8Array() },
    });
    expect(s.markSettled('a', 'b', 'P2')).toBe('served');
    expect(s.get('a')?.paymentResponse).toBe('P');
  });
});
