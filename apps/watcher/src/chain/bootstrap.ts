import { z } from 'zod';
import type obyte from 'obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type { WatcherStore } from '../storage/store.js';
import type { Defender } from './defender.js';

/**
 * Per-connection bootstrap of the watcher's hub client, called from
 * `client.onConnect` (pattern of byteball/oswap-token-ui `bootstrap.js`).
 *
 * The hub forgets watches when a connection drops, so on EVERY
 * (re)connection: watch the seller address and each channel AA, refresh the
 * balance and run a full defense pass.
 *
 * The push handler is ONE function registered at most once per live
 * subscription list: obyte.js 0.2.1 empties its subscriber list on each
 * reconnection (so it is registered again then), while other versions keep
 * handlers forever (subscribing on every reconnection would pile up
 * duplicates). When the client's list cannot be inspected, it subscribes once.
 * A `light/aa_response` of a channel (e.g. the client started a close)
 * triggers an immediate defense instead of waiting for the next poll.
 *
 * The heartbeat timer stays OUTSIDE (one per client, see obyte.js README):
 * a timer created here would pile up on every reconnection.
 */
export function watchChannel(client: obyte.Client, aa: string): void {
  client.justsaying('light/new_aa_to_watch', { aa });
}

/** A hub push: `['justsaying', { subject, body }]`. */
const pushSchema = z.tuple([
  z.literal('justsaying'),
  z
    .object({ subject: z.string(), body: z.record(z.string(), z.unknown()).nullable().optional() })
    .loose(),
]);

export function createBootstrap(deps: {
  client: obyte.Client;
  store: WatcherStore;
  defender: Pick<Defender, 'tick' | 'defendNow'>;
  seller: string;
  refreshBalance: () => Promise<unknown>;
  logger: Logger;
}): () => Promise<void> {
  const log = moduleLogger(deps.logger, 'watcher.bootstrap');
  const onPush = (err: unknown, message: unknown) => {
    if (err) return;
    const push = pushSchema.safeParse(message);
    if (!push.success) return;
    const { subject, body } = push.data[1];
    const aa = body?.['aa_address'];
    if (subject === 'light/aa_response' && typeof aa === 'string') {
      log.info({ aa, trigger: body?.['trigger_unit'] }, 'channel AA responded');
      deps.defender
        .defendNow(aa)
        .catch((e: unknown) => log.error({ err: e, aa }, 'defending the channel failed'));
    } else if (subject === 'joint' || subject === 'light/have_updates') {
      deps.refreshBalance().catch((e: unknown) => log.warn({ err: e }, 'balance refresh failed'));
    }
  };
  let subscribed = false;
  return async () => {
    const { client } = deps;
    client.justsaying('light/new_address_to_watch', deps.seller);
    const channels = await deps.store.channels();
    for (const ch of channels) watchChannel(client, ch.aa);
    const live = subscriberList(client);
    if (live === undefined ? !subscribed : !live.includes(onPush)) {
      client.subscribe(onPush);
      subscribed = true;
    }
    await deps.refreshBalance();
    await deps.defender.tick();
    log.info({ channels: channels.length }, 'bootstrap done');
  };
}

/** obyte.js' internal subscriber list (`client.client.notifications`), if it can be read. */
function subscriberList(client: obyte.Client): readonly unknown[] | undefined {
  const list = (client as unknown as { client?: { notifications?: unknown } }).client
    ?.notifications;
  return Array.isArray(list) ? list : undefined;
}
