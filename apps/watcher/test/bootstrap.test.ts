import { Writable } from 'node:stream';
import { createLogger } from '@obbyx/obyte/logger';
import { describe, expect, it } from 'vitest';
import { createBootstrap } from '../src/chain/bootstrap.js';
import type { WatcherStore } from '../src/storage/store.js';

const silent = createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) });

/** Mimics obyte.js: subscriptions are dropped on every (re)connection. */
function fakeClient() {
  let subscribers: ((err: unknown, msg: unknown) => void)[] = [];
  const justsayings: [string, unknown][] = [];
  return {
    justsayings,
    reconnect: () => (subscribers = []),
    push: (subject: string, body: unknown) =>
      subscribers.forEach((s) => s(null, ['justsaying', { subject, body }])),
    client: {
      justsaying: (subject: string, body: unknown) => justsayings.push([subject, body]),
      subscribe: (cb: (err: unknown, msg: unknown) => void) => subscribers.push(cb),
    },
  };
}

describe('watcher bootstrap (per connection)', () => {
  it('watches the seller and channels, reacts to AA responses, and re-subscribes after reconnect', async () => {
    const fake = fakeClient();
    const defended: string[] = [];
    let ticks = 0;
    let balances = 0;
    const bootstrap = createBootstrap({
      client: fake.client as never,
      store: { channels: async () => [{ aa: 'AA1' }, { aa: 'AA2' }] } as unknown as WatcherStore,
      defender: {
        tick: async () => void (ticks += 1),
        defendNow: async (aa: string) => void defended.push(aa),
      },
      seller: 'SELLER',
      refreshBalance: async () => (balances += 1),
      logger: silent,
    });

    await bootstrap();
    expect(fake.justsayings).toEqual([
      ['light/new_address_to_watch', 'SELLER'],
      ['light/new_aa_to_watch', { aa: 'AA1' }],
      ['light/new_aa_to_watch', { aa: 'AA2' }],
    ]);
    expect(ticks).toBe(1);
    fake.push('light/aa_response', { aa_address: 'AA2', trigger_unit: 'U' });
    expect(defended).toEqual(['AA2']);

    // Connection dropped: obyte.js forgets the subscription; onConnect runs bootstrap again.
    fake.reconnect();
    fake.push('light/aa_response', { aa_address: 'AA1' });
    expect(defended).toEqual(['AA2']);
    await bootstrap();
    fake.push('light/aa_response', { aa_address: 'AA1' });
    expect(defended).toEqual(['AA2', 'AA1']);
    expect(fake.justsayings.filter(([s]) => s === 'light/new_aa_to_watch')).toHaveLength(4);
    expect(ticks).toBe(2);
    expect(balances).toBe(2);
  });
});
