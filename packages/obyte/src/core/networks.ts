import { ObbyxError } from './errors.js';

/**
 * Obyte networks and their identifiers.
 *
 * - x402 v2 uses CAIP-2 identifiers. No `obyte` namespace exists in
 *   ChainAgnostic/namespaces yet, so `obyte:livenet` / `obyte:testnet` are
 *   provisional until agreed upstream (see docs/adr/0004-network-identifiers.md).
 * - x402 v1 uses plain strings, so each network also has a v1 name.
 *
 * Every storage, lock and dedup key must include the network (invariant I4);
 * use {@link networkKey} to build such keys.
 */
export type ObyteNetworkName = 'livenet' | 'testnet';
export type Caip2 = `${string}:${string}`;

export interface ObyteNetwork {
  readonly name: ObyteNetworkName;
  readonly caip2: Caip2;
  readonly v1Name: string;
  readonly testnet: boolean;
  readonly defaultHubUrl: string;
  readonly explorerUrl: string;
}

export const OBYTE_CAIP_FAMILY = 'obyte:*' as const;

export const OBYTE_NETWORKS: Readonly<Record<ObyteNetworkName, ObyteNetwork>> = Object.freeze({
  livenet: Object.freeze({
    name: 'livenet',
    caip2: 'obyte:livenet',
    v1Name: 'obyte-livenet',
    testnet: false,
    defaultHubUrl: 'wss://obyte.org/bb',
    explorerUrl: 'https://explorer.obyte.org',
  }),
  testnet: Object.freeze({
    name: 'testnet',
    caip2: 'obyte:testnet',
    v1Name: 'obyte-testnet',
    testnet: true,
    defaultHubUrl: 'wss://obyte.org/bb-test',
    explorerUrl: 'https://testnetexplorer.obyte.org',
  }),
});

const BY_ID: ReadonlyMap<string, ObyteNetwork> = new Map(
  Object.values(OBYTE_NETWORKS).flatMap((n) => [
    [n.caip2, n],
    [n.v1Name, n],
  ]),
);

export class UnsupportedNetworkError extends ObbyxError {
  constructor(id: string) {
    super('invalid_network', `Unsupported Obyte network: ${id}`, { details: { network: id } });
  }
}

/** Resolves a v2 CAIP-2 id or a v1 network name; throws for anything else. */
export function getNetwork(id: string): ObyteNetwork {
  const network = BY_ID.get(id);
  if (!network) throw new UnsupportedNetworkError(id);
  return network;
}

export function isObyteNetwork(id: string): boolean {
  return BY_ID.has(id);
}

/** Builds a key namespaced by network, e.g. `obyte:testnet:unit:<hash>`. */
export function networkKey(network: ObyteNetwork, ...parts: readonly string[]): string {
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new ObbyxError('invalid_key', 'networkKey requires non-empty parts');
  }
  return [network.caip2, ...parts].join(':');
}

export function explorerUnitUrl(network: ObyteNetwork, unit: string): string {
  return `${network.explorerUrl}/${encodeURIComponent(unit)}`;
}
