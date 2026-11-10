import { describe, expect, it } from 'vitest';
import { createBootstrap } from '../src/chain/bootstrap.js';
import type { WatcherStore } from '../src/storage/store.js';
import { silentLogger } from '../../../packages/obyte/test/helpers.js';

const silent = silentLogger();

type Sub = (err: unknown, msg: unknown) => void;

/**
 * Mimics obyte.js. `dropsOnReconnect`: 0.2.1 empties its subscriber list
 * (`client.client.notifications`) on every (re)connection; other versions keep
 * every handler forever. `exposesList: false` hides the internal list.
 */
function fakeClient(opts: { dropsOnReconnect: boolean; exposesList?: boolean }) {
  const ws = { notifications: [] as Sub[] };
  const justsayings: [string, unknown][] = [];
  return {
    justsayings,
    subscribers: () => ws.notifications,
    reconnect: () => {
      if (opts.dropsOnReconnect) ws.notifications = [];
    },
    push: (subject: string, body: unknown) =>
      ws.notifications.forEach((s) => s(null, ['justsaying', { subject, body }])),
    client: {
      ...(opts.exposesList === false ? {} : { client: ws }),
      justsaying: (subject: string, body: unknown) => justsayings.push([subject, body]),
      subscribe: (cb: Sub) => ws.notifications.push(cb),
    },
  };
}

describe('watcher bootstrap (per connection)', () => {
  it('watches the seller and channels, reacts to AA responses, and re-subscribes after reconnect', async () => {
    const fake = fakeClient({ dropsOnReconnect: true });
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
    expect(fake.subscribers()).toHaveLength(1);
  });

  it.each([
    ['keeps handlers across reconnections', { dropsOnReconnect: false }],
    ['has no inspectable subscriber list', { dropsOnReconnect: false, exposesList: false }],
  ])('subscribes once when the client %s (no duplicate handlers)', async (_n, opts) => {
    const fake = fakeClient(opts);
    const defended: string[] = [];
    const bootstrap = createBootstrap({
      client: fake.client as never,
      store: { channels: async () => [{ aa: 'AA1' }] } as unknown as WatcherStore,
      defender: {
        tick: async () => undefined,
        defendNow: async (aa: string) => void defended.push(aa),
      },
      seller: 'SELLER',
      refreshBalance: async () => 0,
      logger: silent,
    });
    await bootstrap();
    fake.reconnect();
    await bootstrap();
    fake.reconnect();
    await bootstrap();
    expect(fake.subscribers()).toHaveLength(1);
    fake.push('light/aa_response', { aa_address: 'AA1' });
    expect(defended).toEqual(['AA1']);
  });
});
