import type { FastifyInstance } from 'fastify';
import { type DiscoveryCatalog, toDiscoveryResource } from '../../discovery/catalog.js';
import { resourcesQuerySchema, searchQuerySchema } from '../schemas.js';

/** Bazaar discovery (public, read-only): GET /discovery/resources and /discovery/search. */
export function registerDiscoveryRoutes(
  http: FastifyInstance,
  catalog: DiscoveryCatalog | undefined,
): void {
  http.get('/discovery/resources', async (request, reply) => {
    if (catalog === undefined) return reply.status(404).send({ error: 'discovery disabled' });
    const parsed = resourcesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid query' });
    const q = parsed.data;
    const { items, total } = await catalog.list({
      ...filtersOf(q),
      offset: q.offset,
      limit: q.limit,
    });
    return {
      x402Version: 2,
      items: items.map(toDiscoveryResource),
      pagination: { limit: q.limit, offset: q.offset, total },
    };
  });

  http.get('/discovery/search', async (request, reply) => {
    if (catalog === undefined) return reply.status(404).send({ error: 'discovery disabled' });
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'query is required' });
    const q = parsed.data;
    const { items, total } = await catalog.list({
      ...filtersOf(q),
      text: q.query,
      offset: q.cursor,
      limit: q.limit,
    });
    const next = q.cursor + items.length < total ? String(q.cursor + items.length) : null;
    return {
      x402Version: 2,
      resources: items.map(toDiscoveryResource),
      pagination: { limit: q.limit, cursor: next },
    };
  });
}

function filtersOf(q: {
  type?: string | undefined;
  payTo?: string | undefined;
  scheme?: string | undefined;
  network?: string | undefined;
}) {
  return {
    ...(q.type ? { type: q.type } : {}),
    ...(q.payTo ? { payTo: q.payTo } : {}),
    ...(q.scheme ? { scheme: q.scheme } : {}),
    ...(q.network ? { network: q.network } : {}),
  };
}
