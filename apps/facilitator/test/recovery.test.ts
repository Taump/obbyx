import type { ExactObyteFacilitator, SettlementRecord, SettlementStore } from '@obbyx/x402-obyte';
import { describe, expect, it } from 'vitest';
import { RecoveryWorker } from '../src/workers/recovery.js';
import { silentLogger } from '../../../packages/obyte/test/helpers.js';

const record = (key: string) => ({ key, unitHash: key }) as SettlementRecord;

describe('recovery worker', () => {
  it('a failing store never rejects a pass (an unhandled rejection would crash the process)', async () => {
    const store = {
      listActive: () => Promise.reject(new Error('disk I/O error')),
    } as unknown as SettlementStore;
    const worker = new RecoveryWorker(store, {} as ExactObyteFacilitator, silentLogger(), 60_000);
    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('rotates every record it looked at, also when resuming it failed', async () => {
    const touched: string[] = [];
    const store = {
      listActive: async () => [record('a'), record('b')],
      touch: async (key: string) => void touched.push(key),
    } as unknown as SettlementStore;
    const exact = {
      resume: async (r: SettlementRecord) => {
        if (r.key === 'a') throw new Error('hub down');
        return { success: false, errorReason: 'settlement_pending' };
      },
    } as unknown as ExactObyteFacilitator;
    await new RecoveryWorker(store, exact, silentLogger(), 60_000).tick();
    expect(touched).toEqual(['a', 'b']);
  });
});
