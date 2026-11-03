import type obyte from 'obyte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../src/hub/heartbeat.js';

afterEach(() => vi.useRealTimers());

describe('startHeartbeat', () => {
  it('calls client.api.heartbeat periodically, survives failures, and stops', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      api: {
        heartbeat: () => {
          calls += 1;
          return calls === 2 ? Promise.reject(new Error('closed')) : Promise.resolve(null);
        },
      },
    } as unknown as obyte.Client;
    const stop = startHeartbeat(client, 10_000);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(calls).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(3);
  });
});
