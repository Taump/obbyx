import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Protection of the externally reachable facilitator endpoints `/verify` and
 * `/settle` (MVP scope: no dashboard, no roles):
 *
 * - optional shared API keys for the sellers' resource servers
 *   (`Authorization: Bearer <key>` or `X-API-Key: <key>`), compared in
 *   constant time; off when no key is configured;
 * - a fixed-window rate limit per client (API key, otherwise IP), so a public
 *   facilitator cannot be used to flood the hub.
 *
 * `/supported`, `/health` and `/discovery/*` (read-only) stay public; `/watcher` has its own signature login.
 */
export interface AccessOptions {
  readonly apiKeys: readonly string[];
  /** Requests per minute per client; 0 disables the limit. */
  readonly ratePerMinute: number;
  readonly now?: () => number;
}

export function presentedKey(request: FastifyRequest): string | undefined {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = request.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : undefined;
}

function keyMatches(presented: string, keys: readonly Buffer[]): boolean {
  const p = Buffer.from(presented);
  let ok = false;
  for (const k of keys) {
    // compare against every key (no early exit) to keep timing independent of which matched
    if (k.length === p.length && timingSafeEqual(k, p)) ok = true;
  }
  return ok;
}

export function createAccessGuard(options: AccessOptions) {
  const keys = options.apiKeys.map((k) => Buffer.from(k));
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, { start: number; count: number }>();

  /** Counts a request in its client's one-minute window; true when over the limit. */
  const overRate = (client: string): boolean => {
    const t = now();
    const w = windows.get(client);
    if (w !== undefined && t - w.start < 60_000) return ++w.count > options.ratePerMinute;
    windows.set(client, { start: t, count: 1 });
    // Bound memory: forget finished windows once there are many clients.
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
    }
    return false;
  };

  /** Returns a rejection to send, or undefined to let the request through. */
  return function check(request: FastifyRequest): { status: number; reason: string } | undefined {
    const presented = presentedKey(request);
    if (keys.length > 0 && (presented === undefined || !keyMatches(presented, keys))) {
      return { status: 401, reason: 'unauthorized' };
    }
    if (options.ratePerMinute > 0) {
      const client =
        keys.length > 0 && presented !== undefined ? `key:${presented}` : `ip:${request.ip}`;
      if (overRate(client)) return { status: 429, reason: 'rate_limited' };
    }
    return undefined;
  };
}

export function rejectionBody(
  path: string,
  reason: string,
  network: string,
): Record<string, unknown> {
  return path.startsWith('/settle')
    ? { success: false, errorReason: reason, transaction: '', network }
    : { isValid: false, invalidReason: reason };
}
