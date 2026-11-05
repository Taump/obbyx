import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import obyte from 'obyte';
import type { ObyteNetwork } from '@obbyx/obyte';
import type { Logger } from '@obbyx/obyte/logger';
import { SqliteBatchStore, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { loadFacilitatorConfig } from '../../../apps/facilitator/src/config.js';
import { buildFacilitator } from '../../../apps/facilitator/src/http/server.js';
import { WsWatcherGateway } from '../../../apps/facilitator/src/watcher/gateway.js';
import { WatcherStore, openWatcherDatabase } from '../../../apps/watcher/src/storage/store.js';
import { FacilitatorLink } from '../../../apps/watcher/src/facilitator/link.js';
import type { FakeHub } from '../../x402-obyte/test/fake-hub.js';

/**
 * The seller side of channel payments for end-to-end tests: an obbyx
 * facilitator with batch-settlement (HTTP + watcher gateway) and the seller's
 * watcher, all on a FakeHub (no network).
 */
export interface ChannelStack {
  readonly facilitatorUrl: string;
  /** The facilitator's channel journal. */
  readonly batchStore: SqliteBatchStore;
  readonly link: FacilitatorLink;
  readonly watcherStore: WatcherStore;
  /** Starts the watcher and waits until the facilitator accepted its login. */
  connectWatcher(): Promise<void>;
  close(): Promise<void>;
}

/** Polls `cond` every 15 ms; throws after `ms`. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** obyte.js client whose hub requests go to the FakeHub. */
export function hubClient(hub: FakeHub): obyte.Client {
  const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  c.close();
  Object.assign((c as unknown as { api: object }).api, hub.client.api);
  return c;
}

/** A fresh watcher database file with every migration applied. */
function watcherDbFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'obbyx-channels-')), 'watcher.db');
  const db = new DatabaseSync(file);
  const dir = new URL('../../../apps/watcher/prisma/migrations/', import.meta.url).pathname;
  for (const m of readdirSync(dir)
    .filter((d) => !d.endsWith('.toml'))
    .sort()) {
    db.exec(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  }
  db.close();
  return file;
}

export async function startChannelStack(options: {
  readonly hub: FakeHub;
  readonly network: ObyteNetwork;
  readonly seller: string;
  readonly sellerKey: Uint8Array;
  readonly logger: Logger;
  readonly minChannelTimeoutSeconds?: number;
}): Promise<ChannelStack> {
  const { hub, network, logger } = options;
  const batchStore = new SqliteBatchStore(new SqliteSettlementStore(':memory:').database);
  const gateway = new WsWatcherGateway({
    store: batchStore,
    logger,
    networks: [network.caip2],
    minBytes: 0n,
    heartbeatTimeoutMs: 60_000,
  });
  const facilitator = buildFacilitator({
    config: loadFacilitatorConfig({
      NETWORKS: network.caip2,
      WATCHER_ACK_TIMEOUT_MS: '300',
      MIN_CHANNEL_TIMEOUT_SECONDS: String(options.minChannelTimeoutSeconds ?? 3600),
    }),
    logger,
    store: new SqliteSettlementStore(':memory:'),
    clients: new Map([[network.caip2, hub.asClient()]]),
    batch: { store: batchStore, gateway },
  });
  gateway.attach(facilitator.http.server);
  const facilitatorUrl = await facilitator.http.listen({ host: '127.0.0.1', port: 0 });

  const watcherStore = new WatcherStore(await openWatcherDatabase(watcherDbFile()));
  const link = new FacilitatorLink({
    url: `${facilitatorUrl.replace('http', 'ws')}/watcher`,
    network,
    seller: options.seller,
    privateKey: options.sellerKey,
    client: hubClient(hub),
    store: watcherStore,
    logger,
    bytesBalance: async () => 1_000_000n,
  });
  return {
    facilitatorUrl,
    batchStore,
    link,
    watcherStore,
    connectWatcher: async () => {
      link.start();
      await until(() => link.connected);
    },
    close: async () => {
      link.stop();
      await gateway.close();
      await facilitator.http.close();
      await watcherStore.close();
    },
  };
}
