import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { extractDiscoveryInfo } from '@x402/extensions/bazaar';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Bazaar discovery (x402 extension): the facilitator catalogs paid resources
 * from the payments it SETTLES (a free /verify never writes), when the resource server declared
 * `extensions.bazaar` and the client echoed it. The declared `info` is
 * validated against its schema by the reference implementation
 * (`extractDiscoveryInfo` from @x402/extensions). The catalog is read through
 * GET /discovery/resources and GET /discovery/search.
 */
export interface CatalogEntry {
  readonly key: string;
  readonly resource: string;
  readonly type: string;
  readonly method?: string;
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly payTo: string;
  readonly accepts: PaymentRequirements[];
  readonly extensions?: Record<string, unknown>;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: string[];
  readonly lastUpdated: string;
}

export interface CatalogQuery {
  readonly type?: string;
  readonly payTo?: string;
  readonly scheme?: string;
  readonly network?: string;
  readonly text?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface DiscoveryCatalog {
  upsert(entry: CatalogEntry): Promise<void>;
  list(query: CatalogQuery): Promise<{ items: CatalogEntry[]; total: number }>;
}

export type CatalogOutcome =
  { status: 'success' } | { status: 'rejected'; rejectedReason: string } | undefined;

/** Catalogs a verified payment's resource; returns the EXTENSION-RESPONSES bazaar status. */
export async function catalogFromPayment(
  catalog: DiscoveryCatalog,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  now: () => Date = () => new Date(),
): Promise<CatalogOutcome> {
  if (payload.extensions?.['bazaar'] === undefined) return undefined;
  let discovered;
  try {
    discovered = extractDiscoveryInfo(payload, requirements, true);
  } catch (err) {
    return {
      status: 'rejected',
      rejectedReason: err instanceof Error ? err.message : 'invalid discovery info',
    };
  }
  if (discovered === null)
    return { status: 'rejected', rejectedReason: 'discovery info failed schema validation' };
  const d = discovered as {
    resourceUrl: string;
    method?: string;
    routeTemplate?: string;
    x402Version: number;
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    extensions?: Record<string, unknown>;
    discoveryInfo: { input?: { type?: string } };
  };
  const type = d.discoveryInfo.input?.type ?? 'http';
  // payTo is part of the key: a listing can never be overwritten to pay
  // someone else (entries are claims of the payer that settled, not of the
  // resource owner; buyers always pay the payTo of the resource's own 402).
  const key = `${type}:${d.method ?? ''}:${d.routeTemplate ?? d.resourceUrl}:${requirements.network}:${requirements.payTo}`;
  await catalog.upsert({
    key,
    resource: d.resourceUrl,
    type,
    ...(d.method ? { method: d.method } : {}),
    x402Version: d.x402Version,
    scheme: requirements.scheme,
    network: requirements.network,
    payTo: requirements.payTo,
    accepts: [stripDynamic(requirements)],
    ...(d.extensions ? { extensions: d.extensions } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.mimeType ? { mimeType: d.mimeType } : {}),
    ...(d.serviceName ? { serviceName: d.serviceName } : {}),
    ...(d.tags ? { tags: d.tags } : {}),
    lastUpdated: now().toISOString(),
  });
  return { status: 'success' };
}

/** Per-request quote fields are not part of a catalog listing. */
function stripDynamic(req: PaymentRequirements): PaymentRequirements {
  const {
    binding: _b,
    quoteId: _q,
    validUntil: _v,
    ...extra
  } = req.extra as Record<string, unknown>;
  void _b;
  void _q;
  void _v;
  return { ...req, extra };
}

export function toDiscoveryResource(e: CatalogEntry) {
  return {
    resource: e.resource,
    type: e.type,
    x402Version: e.x402Version,
    accepts: e.accepts,
    lastUpdated: e.lastUpdated,
    ...(e.description ? { description: e.description } : {}),
    ...(e.mimeType ? { mimeType: e.mimeType } : {}),
    ...(e.serviceName ? { serviceName: e.serviceName } : {}),
    ...(e.tags ? { tags: e.tags } : {}),
    ...(e.extensions ? { extensions: e.extensions } : {}),
  };
}

function matches(e: CatalogEntry, q: CatalogQuery): boolean {
  if (q.type !== undefined && e.type !== q.type) return false;
  if (q.payTo !== undefined && e.payTo !== q.payTo) return false;
  if (q.scheme !== undefined && e.scheme !== q.scheme) return false;
  if (q.network !== undefined && e.network !== q.network) return false;
  if (q.text !== undefined) {
    const hay = [e.resource, e.description, e.serviceName, ...(e.tags ?? [])]
      .join(' ')
      .toLowerCase();
    if (
      !q.text
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => hay.includes(w))
    )
      return false;
  }
  return true;
}

export class MemoryCatalog implements DiscoveryCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  async upsert(entry: CatalogEntry): Promise<void> {
    this.entries.set(entry.key, entry);
  }
  async list(q: CatalogQuery): Promise<{ items: CatalogEntry[]; total: number }> {
    const all = [...this.entries.values()]
      .filter((e) => matches(e, q))
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length };
  }
}

export class PrismaCatalog implements DiscoveryCatalog {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(e: CatalogEntry): Promise<void> {
    const data = {
      resource: e.resource,
      type: e.type,
      method: e.method ?? null,
      x402Version: e.x402Version,
      scheme: e.scheme,
      network: e.network,
      payTo: e.payTo,
      acceptsJson: JSON.stringify(e.accepts),
      extensions: e.extensions ? JSON.stringify(e.extensions) : null,
      description: e.description ?? null,
      mimeType: e.mimeType ?? null,
      serviceName: e.serviceName ?? null,
      tags: e.tags ? JSON.stringify(e.tags) : null,
      lastUpdated: e.lastUpdated,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.discoveryResource.upsert({
        where: { key: e.key },
        create: { key: e.key, ...data },
        update: data,
      });
    });
  }

  async list(q: CatalogQuery): Promise<{ items: CatalogEntry[]; total: number }> {
    const rows = await this.prisma.$transaction(async (tx) =>
      tx.discoveryResource.findMany({
        where: {
          ...(q.type ? { type: q.type } : {}),
          ...(q.payTo ? { payTo: q.payTo } : {}),
          ...(q.scheme ? { scheme: q.scheme } : {}),
          ...(q.network ? { network: q.network } : {}),
        },
        orderBy: { lastUpdated: 'desc' },
        take: 10_000,
      }),
    );
    const all = rows
      .map((r): CatalogEntry => ({
        key: r.key,
        resource: r.resource,
        type: r.type,
        ...(r.method ? { method: r.method } : {}),
        x402Version: r.x402Version,
        scheme: r.scheme,
        network: r.network,
        payTo: r.payTo,
        accepts: JSON.parse(r.acceptsJson) as PaymentRequirements[],
        ...(r.extensions
          ? { extensions: JSON.parse(r.extensions) as Record<string, unknown> }
          : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        ...(r.serviceName ? { serviceName: r.serviceName } : {}),
        ...(r.tags ? { tags: JSON.parse(r.tags) as string[] } : {}),
        lastUpdated: r.lastUpdated,
      }))
      .filter((e) => matches(e, q));
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length };
  }
}
