import { describe, expect, it } from 'vitest';
import { type BestVoucher, type ChannelState, channelState, decide } from '../src/chain/decide.js';

const policy = { closeAtAmount: 1_000n, closeAfterSeconds: 3600 };
const open: ChannelState = {
  period: 3,
  closeInitiatedBy: undefined,
  closeStartTs: undefined,
  spentByB: undefined,
  balanceB: 5_000n,
};
const best = (amountSpent: bigint, period = 3, firstReceivedAt = 1000): BestVoucher => ({
  period,
  amountSpent,
  firstReceivedAt,
});
const run = (state: ChannelState, b?: BestVoucher, now = 1100) =>
  decide({ state, best: b, timeout: 600, now, policy });

describe('watcher decisions', () => {
  it('fraud-proofs a client who declares less than it signed', () => {
    expect(
      run({ ...open, closeInitiatedBy: 'B', closeStartTs: 1000, spentByB: 300n }, best(500n)),
    ).toMatchObject({
      action: 'fraud_proof',
      period: 3,
    });
  });

  it('confirms an honest client close immediately (also when we hold nothing for this period)', () => {
    expect(run({ ...open, closeInitiatedBy: 'B', spentByB: 500n }, best(500n))).toMatchObject({
      action: 'confirm',
    });
    expect(run({ ...open, closeInitiatedBy: 'B', spentByB: 0n }, undefined)).toMatchObject({
      action: 'confirm',
    });
    // a voucher of an OLD period is not evidence for this period
    expect(run({ ...open, closeInitiatedBy: 'B', spentByB: 0n }, best(900n, 2))).toMatchObject({
      action: 'confirm',
    });
  });

  it('waits a grace period before confirming an honest client close (in-flight vouchers)', () => {
    const closing = { ...open, closeInitiatedBy: 'B' as const, closeStartTs: 1000, spentByB: 500n };
    expect(run(closing, best(500n), 1100)).toMatchObject({ action: 'none' });
    expect(run(closing, best(500n), 1120)).toMatchObject({ action: 'confirm', period: 3 });
    // …but a voucher above the declared amount is answered at once
    expect(run(closing, best(600n), 1001)).toMatchObject({ action: 'fraud_proof' });
    // the grace never exceeds half the dispute window
    expect(
      decide({ state: closing, best: best(500n), timeout: 100, now: 1050, policy }),
    ).toMatchObject({
      action: 'confirm',
    });
  });

  it('confirms our own close only after the dispute window', () => {
    const closing = { ...open, closeInitiatedBy: 'A' as const, closeStartTs: 1000 };
    expect(run(closing, best(500n), 1599)).toMatchObject({ action: 'none' });
    expect(run(closing, best(500n), 1600)).toMatchObject({ action: 'confirm', period: 3 });
  });

  it('closes by amount or by age, otherwise waits', () => {
    expect(run(open, best(1_000n))).toMatchObject({ action: 'close' });
    expect(run(open, best(10n, 3, 1000), 4600)).toMatchObject({ action: 'close' });
    expect(run(open, best(10n))).toMatchObject({ action: 'none' });
    expect(run(open, undefined)).toMatchObject({ action: 'none' });
    expect(run({ ...open, period: undefined }, best(10n))).toMatchObject({ action: 'none' });
  });

  it('alerts on a voucher above the confirmed deposit but still cashes out (the AA clamps)', () => {
    // over the close threshold: close anyway, with the alert attached
    expect(run({ ...open, balanceB: 100n }, best(1_500n))).toMatchObject({
      action: 'close',
      period: 3,
      alert: expect.stringContaining('exceeds balanceB'),
    });
    // by age as well
    expect(run({ ...open, balanceB: 100n }, best(500n, 3, 1000), 4600)).toMatchObject({
      action: 'close',
      alert: expect.any(String),
    });
    // within policy: no action, but the alert is still reported
    expect(run({ ...open, balanceB: 100n }, best(500n))).toMatchObject({
      action: 'none',
      alert: expect.any(String),
    });
    // a normal voucher carries no alert
    expect(run(open, best(1_000n))).not.toHaveProperty('alert');
  });

  it('a client close with a voucher above the declared amount yields a fraud proof (even above balanceB)', () => {
    expect(
      run(
        { ...open, balanceB: 100n, closeInitiatedBy: 'B', closeStartTs: 1000, spentByB: 50n },
        best(500n),
      ),
    ).toMatchObject({ action: 'fraud_proof', period: 3 });
  });

  it('parses AA state vars', () => {
    expect(
      channelState({
        period: 2,
        close_initiated_by: 'B',
        close_start_ts: 7,
        spentByB: 5,
        balanceB: 9,
      }),
    ).toEqual({
      period: 2,
      closeInitiatedBy: 'B',
      closeStartTs: 7,
      spentByB: 5n,
      balanceB: 9n,
    });
    expect(channelState({})).toMatchObject({ period: undefined, balanceB: 0n });
    // after a close the AA deletes balanceB: absent is a zero balance
    expect(channelState({ period: 4 })).toMatchObject({ period: 4, balanceB: 0n });
  });

  it.each([
    ['a string balanceB', { period: 2, balanceB: '9' }],
    ['a boolean balanceB', { period: 2, balanceB: true }],
    ['a fractional balanceB', { period: 2, balanceB: 1.5 }],
    ['a string period', { period: '2', balanceB: 9 }],
    ['a null spentByB', { period: 2, balanceB: 9, spentByB: null }],
    ['an unknown initiator', { period: 2, balanceB: 9, close_initiated_by: 'C' }],
  ])('treats %s as a malformed state (skip the tick), never as 0', (_n, vars) => {
    expect(channelState(vars)).toBeUndefined();
  });
});
