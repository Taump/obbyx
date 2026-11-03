import type { FastifyInstance } from 'fastify';
import type { SettlementStore } from '@obbyx/x402-obyte';
import type { FacilitatorConfig } from '../../config.js';
import { buildOpenApi } from '../openapi.js';

/** GET /health and GET /openapi.json. */
export function registerMetaRoutes(
  http: FastifyInstance,
  deps: { config: FacilitatorConfig; store: SettlementStore },
): void {
  http.get('/health', async () => ({
    ok: true,
    networks: deps.config.networks.map((n) => n.network.caip2),
    finality: deps.config.finality,
    activeSettlements: (await deps.store.listActive(1000)).length,
  }));
  const openApi = buildOpenApi();
  http.get('/openapi.json', async () => openApi);
}
