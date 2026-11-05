import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type {
  BatchObyteFacilitator,
  BatchStore,
  ExactObyteFacilitator,
  SettlementStore,
  WatcherGateway,
} from '@obbyx/x402-obyte';
import type obyte from 'obyte';
import type { FacilitatorConfig } from '../config.js';
import {
  type CatalogOutcome,
  type DiscoveryCatalog,
  catalogFromPayment,
} from '../discovery/catalog.js';
import { buildMechanisms } from '../mechanisms.js';
import { createAccessGuard, rejectionBody } from './access.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerPaymentRoutes } from './routes/payments.js';

/**
 * HTTP facilitator (x402 v2 REST): POST /verify, POST /settle, GET /supported,
 * Bazaar discovery, GET /health, GET /openapi.json. The x402 core facilitator
 * with the Obyte mechanisms does the work; this module wires HTTP concerns:
 * access control, body limits, error mapping, request ids.
 */
export interface FacilitatorDeps {
  readonly config: FacilitatorConfig;
  readonly logger: Logger;
  readonly store: SettlementStore;
  readonly clients: ReadonlyMap<string, obyte.Client>;
  /** batch-settlement storage and the sellers' watcher gateway (omit to disable). */
  readonly batch?: { readonly store: BatchStore; readonly gateway: WatcherGateway };
  /** Bazaar discovery catalog (omit to disable the extension). */
  readonly catalog?: DiscoveryCatalog;
  readonly now?: () => number;
}

export interface FacilitatorApp {
  readonly http: FastifyInstance;
  readonly exact: ExactObyteFacilitator;
  readonly batch: BatchObyteFacilitator | undefined;
  readonly core: x402Facilitator;
}

export function buildFacilitator(deps: FacilitatorDeps): FacilitatorApp {
  const { config, logger, store } = deps;
  const log = moduleLogger(logger, 'facilitator.http');
  const defaultNetwork = config.networks[0]?.network.caip2 ?? 'obyte:testnet';
  const { core, exact, batch } = buildMechanisms({ ...deps, bazaar: deps.catalog !== undefined });

  core
    .onAfterVerify(async ({ result, requirements }) => {
      log.info(
        { isValid: result.isValid, reason: result.invalidReason, network: requirements.network },
        'verify result',
      );
    })
    .onAfterSettle(async ({ result, requirements }) => {
      log.info(
        {
          success: result.success,
          reason: result.errorReason,
          network: requirements.network,
          transaction: result.transaction,
        },
        'settle result',
      );
    });

  const http: FastifyInstance = Fastify({
    loggerInstance: moduleLogger(logger, 'facilitator.fastify') as FastifyBaseLogger,
    bodyLimit: config.bodyLimitBytes,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && /^[\w.-]{1,64}$/.test(header) ? header : randomUUID();
    },
  });

  // Malformed JSON → x402 reference behaviour: 400 with invalid_json.
  http.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    const reason =
      status === 413 ? 'payload_too_large' : status === 400 ? 'invalid_json' : 'internal_error';
    void reply
      .status(status)
      .send(rejectionBody(request.routeOptions.url ?? request.url, reason, defaultNetwork));
  });

  // /verify and /settle are the externally reachable payment endpoints.
  const guard = createAccessGuard({ apiKeys: config.apiKeys, ratePerMinute: config.ratePerMinute });
  http.addHook('onRequest', async (request, reply) => {
    // Decide on the MATCHED route, never on the raw URL: the router decodes
    // percent-escapes, so `/%76erify` reaches the /verify handler.
    const path = request.routeOptions.url;
    if (path !== '/verify' && path !== '/settle') return;
    const rejection = guard(request);
    if (rejection === undefined) return;
    log.warn({ reason: rejection.reason, ip: request.ip, path }, 'request refused');
    return reply
      .status(rejection.status)
      .send(rejectionBody(path, rejection.reason, defaultNetwork));
  });

  registerPaymentRoutes(http, {
    core,
    log,
    defaultNetwork,
    ...(deps.catalog === undefined ? {} : { afterSettle: bazaarReporter(deps.catalog, log) }),
  });
  registerDiscoveryRoutes(http, deps.catalog);
  registerMetaRoutes(http, { config, store });
  return { http, exact, batch, core };
}

/**
 * Catalogs a resource after a SUCCESSFUL settle (a real payment, not a free
 * /verify) and reports it to the resource server in EXTENSION-RESPONSES.
 */
function bazaarReporter(catalog: DiscoveryCatalog, log: Logger) {
  return async (
    reply: { header(name: string, value: string): unknown },
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<void> => {
    let outcome: CatalogOutcome;
    try {
      outcome = await catalogFromPayment(catalog, payload, requirements);
    } catch (err) {
      log.error({ err }, 'cataloging failed');
      outcome = { status: 'rejected', rejectedReason: 'internal error' };
    }
    if (outcome !== undefined) {
      reply.header(
        'EXTENSION-RESPONSES',
        Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64'),
      );
    }
  };
}
