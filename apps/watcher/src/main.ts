#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import obyte from 'obyte';
import { OBYTE_NETWORKS, getNetwork } from '@obbyx/obyte';
import { ConfigError, loadConfig } from '@obbyx/obyte/config';
import { createLoggerFromEnv, moduleLogger } from '@obbyx/obyte/logger';
import { loadWallet, walletPath } from '@obbyx/obyte/wallet';
import { hubCall, parseBalances, startHeartbeat } from '@obbyx/x402-obyte';
import { type WatcherEnv, watcherEnvSchema as schema } from './config.js';
import { WatcherStore, openWatcherDatabase } from './storage/store.js';
import { Defender } from './chain/defender.js';
import { createBootstrap, watchChannel } from './chain/bootstrap.js';
import { FacilitatorLink } from './facilitator/link.js';

/**
 * Seller watcher: keeps the client-signed vouchers of the seller's channels,
 * acks them to the facilitator only after storing them, and defends/closes the
 * channels on-chain. Run ONE watcher per seller address.
 */

async function main(): Promise<void> {
  const logger = createLoggerFromEnv('obbyx-watcher');
  const log = moduleLogger(logger, 'watcher.main');
  // The watcher defends channels: one failing async task must not stop it.
  process.on('unhandledRejection', (err) =>
    log.error({ err }, 'unhandled rejection (watcher keeps running)'),
  );
  let env: WatcherEnv;
  try {
    env = loadConfig(schema, process.env);
  } catch (err) {
    log.fatal(
      { issues: err instanceof ConfigError ? err.issues : undefined },
      'invalid configuration',
    );
    process.exit(1);
  }
  const network =
    env.NETWORK === 'testnet' || env.NETWORK === 'livenet'
      ? OBYTE_NETWORKS[env.NETWORK]
      : getNetwork(env.NETWORK);

  // Seller key: the wallet file for this network (`obbyx init`), fully verified.
  let wallet: ReturnType<typeof loadWallet>;
  try {
    wallet = loadWallet(network, { ...process.env, OBBYX_HOME: env.OBBYX_HOME });
  } catch (err) {
    log.fatal(
      { err, walletFile: walletPath(network, { OBBYX_HOME: env.OBBYX_HOME }) },
      'cannot load the seller wallet; run `obbyx init` with OBBYX_HOME pointing to the seller home',
    );
    process.exit(1);
  }
  const { privateKey } = wallet;

  if (env.DB_PATH !== ':memory:') mkdirSync(dirname(env.DB_PATH), { recursive: true });
  const store = new WatcherStore(await openWatcherDatabase(env.DB_PATH));
  const client = new obyte.Client(env.HUB_URL ?? network.defaultHubUrl, {
    testnet: network.testnet,
    reconnect: true,
  });
  const stopHeartbeat = startHeartbeat(client); // one timer per client, outside onConnect
  const firstConnection = new Promise<void>((resolve) => client.onConnect(resolve));
  client.onError((err: unknown) => log.warn({ err }, 'hub connection error'));

  let cachedBalance = 0n;
  const refreshBalance = async () => {
    const res = await hubCall(() => client.api.getBalances([wallet.address]), env.HUB_TIMEOUT_MS);
    const balances = res.kind === 'ok' ? parseBalances(res.value, wallet.address) : undefined;
    // Hub down or malformed answer: keep the last known value.
    if (balances !== undefined) {
      const base = balances['base'];
      cachedBalance = base === undefined ? 0n : base.stable + base.pending;
    }
    return cachedBalance;
  };
  await firstConnection;
  await refreshBalance();

  const wsUrl = new URL('/watcher', env.FACILITATOR_URL);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const link = new FacilitatorLink({
    url: wsUrl.toString(),
    network,
    seller: wallet.address,
    privateKey,
    client,
    store,
    logger,
    hubTimeoutMs: env.HUB_TIMEOUT_MS,
    bytesBalance: refreshBalance,
    onNewChannel: (aa) => watchChannel(client, aa),
  });
  const defender = new Defender({
    client,
    store,
    logger,
    privateKey,
    testnet: network.testnet,
    policy: { closeAtAmount: env.CLOSE_AT_AMOUNT, closeAfterSeconds: env.CLOSE_AFTER_SECONDS },
    hubTimeoutMs: env.HUB_TIMEOUT_MS,
    // `link` is created below; announce runs only later, from a defence pass.
    announce: () => link.announce(),
  });

  const bootstrap = createBootstrap({
    client,
    store,
    defender,
    seller: wallet.address,
    refreshBalance,
    logger,
  });
  client.onConnect(
    () => void bootstrap().catch((err: unknown) => log.error({ err }, 'bootstrap failed')),
  );
  await bootstrap();

  link.start();
  const timer = setInterval(() => void defender.tick(), env.POLL_INTERVAL_MS);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return; // a second signal must not close everything twice
    stopping = true;
    log.info({ signal }, 'shutting down');
    clearInterval(timer);
    link.stop();
    await defender.tick();
    stopHeartbeat();
    client.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  log.info(
    {
      seller: wallet.address,
      network: network.caip2,
      facilitator: wsUrl.toString(),
      db: env.DB_PATH,
      bytes: cachedBalance.toString(),
    },
    'watcher started',
  );
}

void main();
