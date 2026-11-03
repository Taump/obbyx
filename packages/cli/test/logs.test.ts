import { describe, expect, it } from 'vitest';
import { format, matches } from '../src/lib/logs.js';

const entry = {
  level: 'info',
  time: '2026-11-03T17:21:08.668Z',
  service: 'obbyx-facilitator',
  module: 'x402.batch',
  msg: 'voucher committed (watcher ack)',
  binding: 'b1',
  proofId: 'p1',
  aa: 'AA',
  seq: 2,
};

describe('obbyx logs', () => {
  it('filters by correlation fields and level', () => {
    expect(matches(entry, { binding: 'b1' })).toBe(true);
    expect(matches(entry, { binding: 'b2' })).toBe(false);
    expect(matches(entry, { proof: 'p1', aa: 'AA' })).toBe(true);
    expect(matches(entry, { level: 'warn' })).toBe(false);
    expect(matches({ ...entry, level: 'error' }, { level: 'warn' })).toBe(true);
  });

  it('formats one readable line', () => {
    expect(format(entry)).toBe(
      '17:21:08.668 info  obbyx-facilitator/x402.batch: voucher committed (watcher ack)  binding=b1 proofId=p1 aa=AA seq=2',
    );
  });
});
