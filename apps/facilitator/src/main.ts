#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import obyte from 'obyte';
import { ConfigError } from '@obbyx/obyte/config';
import { createLoggerFromEnv, moduleLogger } from '@obbyx/obyte/logger';
import { StoreLockedError, startHeartbeat } from '@obbyx/x402-obyte';
import { SchemaNotMigratedError, openDatabase } from './storage/database.js';
import { PrismaBatchStore } from './storage/batch-store.js';
import { PrismaCatalog } from './discovery/catalog.js';
import { CHANNEL_BASE_AA_NETWORKS, ObbyxError } from '@obbyx/obyte';
import { PrismaSettlementStore } from './storage/settlement-store.js';
import { WsWatcherGateway } from './watcher/gateway.js';
import { loadFacilitatorConfig, packageKeyNextToDb } from './config.js';
import { RecoveryWorker } from './workers/recovery.js';
import { buildFacilitator } from './http/server.js';

async function main(): Promise<void> {
  const logger = createLoggerFromEnv('obbyx-facilitator');
  const log = moduleLogger(logger, 'facilitator.main');

  let config;
  try {
    config = loadFacilitatorConfig();
  } catch (err) {
    log.fatal(
      { issues: err instanceof ConfigError ? err.issues : undefined, err },
      'invalid configuration',
    );
    process.exit(1);
  }

  if (packageKeyNextToDb(config)) {
    log.warn(
      { packageKeyFile: config.packageKeyFile, dbPath: config.dbPath },
      'PACKAGE_KEY_FILE is inside the database directory: a copy of it holds both the encrypted packages and their key; move the key (docs/guide/security.md)',
    );
  }
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  let store: PrismaSettlementStore;
  let batchStore: PrismaBatchStore;
  let catalog: PrismaCatalog;
  try {
    const prisma = await openDatabase(config.dbPath);
    store = new PrismaSettlementStore(prisma);
    batchStore = await PrismaBatchStore.open(prisma, config.packageKeyFile, logger);
    catalog = new PrismaCatalog(prisma);
  } catch (err) {
    const known =
      err instanceof StoreLockedError ||
      err instanceof SchemaNotMigratedError ||
      err instanceof ObbyxError;
    log.fatal({ err }, known ? err.message : 'cannot open database');
    process.exit(1);
  }

  const stopHeartbeats: (() => void)[] = [];
  const firstConnections: Promise<void>[] = [];
  const clients = new Map(
    config.networks.map((n) => {
      const client = new obyte.Client(n.hubUrl, { testnet: n.network.testnet, reconnect: true });
      client.onError((err: unknown) => log.warn({ err, hub: n.hubUrl }, 'hub connection error'));
      // Fires on every (re)connection; everything per-connection belongs here.
      firstConnections.push(new Promise<void>((resolve) => client.onConnect(resolve)));
      client.onConnect(() =>
        log.info({ hub: n.hubUrl, network: n.network.caip2 }, 'hub connected'),
      );
      stopHeartbeats.push(startHeartbeat(client)); // one timer per client, outside onConnect
      return [n.network.caip2, client] as const;
    }),
  );

  const gateway = new WsWatcherGateway({
    store: batchStore,
    logger,
    // Watchers only where channels exist (see buildMechanisms).
    networks: config.networks
      .map((n) => n.network.caip2)
      .filter((n) => CHANNEL_BASE_AA_NETWORKS.has(n)),
    minBytes: config.batch.minWatcherBytes,
    heartbeatTimeoutMs: config.batch.heartbeatTimeoutMs,
    events: (e) => store.event(e),
  });
  const app = buildFacilitator({
    config,
    logger,
    store,
    clients,
    batch: { store: batchStore, gateway },
    catalog,
  });
  gateway.attach(app.http.server);
  const recovery = new RecoveryWorker(store, app.exact, logger, config.recoveryIntervalMs);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    await gateway.close();
    await app.http.close();
    await recovery.stop();
    for (const stop of stopHeartbeats) stop();
    for (const client of clients.values()) client.close();
    await store.close();
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Serve once the hubs are connected (requests would queue anyway; a hub that
  // stays down only makes verify/settle fail closed).
  const connectedInTime = await Promise.race([
    Promise.all(firstConnections).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000).unref()),
  ]);
  if (!connectedInTime)
    log.warn('not all hubs connected within 15 s; starting anyway (fail-closed)');
  await app.http.listen({ host: config.host, port: config.port });
  recovery.start();
  log.info(
    {
      address: `http://${config.host}:${config.port}`,
      networks: config.networks.map((n) => ({
        network: n.network.caip2,
        hub: n.hubUrl,
        assets: [...n.assets],
      })),
      finality: config.finality,
      db: config.dbPath,
    },
    'facilitator started',
  );
}

void main();
