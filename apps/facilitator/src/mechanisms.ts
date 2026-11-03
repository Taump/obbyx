import { x402Facilitator } from '@x402/core/facilitator';
import type { Network } from '@x402/core/types';
import type { Logger } from '@obbyx/obyte/logger';
import {
  BatchObyteFacilitator,
  type BatchStore,
  ExactObyteFacilitator,
  ExactObyteFacilitatorV1,
  type SettlementStore,
  type WatcherGateway,
} from '@obbyx/x402-obyte';
import type obyte from 'obyte';
import type { FacilitatorConfig } from './config.js';

export interface MechanismDeps {
  readonly config: FacilitatorConfig;
  readonly logger: Logger;
  readonly store: SettlementStore;
  readonly clients: ReadonlyMap<string, obyte.Client>;
  readonly batch?: { readonly store: BatchStore; readonly gateway: WatcherGateway };
  readonly bazaar: boolean;
  readonly now?: () => number;
}

export interface Mechanisms {
  readonly core: x402Facilitator;
  readonly exact: ExactObyteFacilitator;
  readonly batch: BatchObyteFacilitator | undefined;
}

/**
 * Registers the Obyte schemes on an x402 core facilitator (strategy per
 * scheme/network): `exact` for v2 and v1, `batch-settlement` for v2 when a
 * batch store and watcher gateway are given, and the Bazaar extension.
 */
export function buildMechanisms(deps: MechanismDeps): Mechanisms {
  const { config, logger, store, clients } = deps;
  const allowedAssets = new Map(config.networks.map((n) => [n.network.caip2, n.assets]));
  const time = deps.now ? { now: deps.now } : {};

  const exact = new ExactObyteFacilitator({
    clients,
    store,
    logger,
    allowedAssets,
    finality: config.finality,
    facilitatorAddresses: config.facilitatorAddresses,
    hubTimeoutMs: config.hubTimeoutMs,
    maxClockSkewSeconds: config.maxClockSkewSeconds,
    publishWindowSeconds: config.publishWindowSeconds,
    maxLastBallAgeSeconds: config.maxLastBallAgeSeconds,
    ...time,
  });

  const batch =
    deps.batch !== undefined && config.batch.enabled
      ? new BatchObyteFacilitator({
          clients,
          store: deps.batch.store,
          gateway: deps.batch.gateway,
          logger,
          allowedAssets,
          minChannelTimeoutSeconds: config.batch.minChannelTimeoutSeconds,
          hubTimeoutMs: config.hubTimeoutMs,
          ackTimeoutMs: config.batch.ackTimeoutMs,
          events: (e) => store.event(e),
          ...time,
        })
      : undefined;

  const networks = config.networks.map((n) => n.network.caip2);
  const core = new x402Facilitator().register(networks, exact);
  // x402 v1 (exact only): plain network names, same mechanism and store.
  core.registerV1(
    config.networks.map((n) => n.network.v1Name as Network),
    new ExactObyteFacilitatorV1(exact),
  );
  if (batch !== undefined) core.register(networks, batch);
  if (deps.bazaar) core.registerExtension({ key: 'bazaar' });
  return { core, exact, batch };
}
