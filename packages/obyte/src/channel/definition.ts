import obyte from 'obyte';
import { type Verdict, accept, isPlainObject, reject } from '../core/result.js';

/**
 * AA payment channels (aa-channels-lib, base AA v1.1).
 *
 * Party A is the payee (seller, x402 `payTo`), party B the payer (client).
 * A channel address is derived from its parameters, so binding a payment to a
 * seller is a matter of recomputing the address (ADR-0003): parameters are
 * taken from the on-chain definition, never trusted from a package alone.
 */
export const CHANNEL_BASE_AA = '4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ';

export interface ChannelParams {
  readonly addressA: string;
  readonly addressB: string;
  /** `'base'` for bytes, otherwise a 44-char asset id. */
  readonly asset: string;
  readonly salt?: string;
  /** Dispute window in seconds. */
  readonly timeout: number;
}

export type ChannelDefinition = readonly [
  'autonomous agent',
  { readonly base_aa: string; readonly params: ChannelParams },
];

/** obyte.js `isValidAddress` as a type guard; it also rejects non-strings. */
export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && obyte.utils.isValidAddress(value);
}

const ASSET_RE = /^[A-Za-z0-9+/]{43}=$/;

export function isAssetId(value: unknown): value is string {
  return value === 'base' || (typeof value === 'string' && ASSET_RE.test(value));
}

export function validateChannelParams(params: unknown): Verdict<ChannelParams> {
  if (!isPlainObject(params)) return reject('invalid_channel_params', 'Params must be an object');
  const { addressA, addressB, asset, salt, timeout } = params;
  const extra = Object.keys(params).filter(
    (k) => !['addressA', 'addressB', 'asset', 'salt', 'timeout'].includes(k),
  );
  if (extra.length > 0)
    return reject('invalid_channel_params', `Unexpected params: ${extra.join(', ')}`);
  if (!isAddress(addressA) || !isAddress(addressB)) {
    return reject('invalid_channel_params', 'addressA and addressB must be valid addresses');
  }
  if (addressA === addressB) return reject('invalid_channel_params', 'Parties must differ');
  if (!isAssetId(asset)) return reject('invalid_channel_params', 'Invalid asset');
  if (salt !== undefined && (typeof salt !== 'string' || salt.length === 0 || salt.length > 100)) {
    return reject('invalid_channel_params', 'Invalid salt');
  }
  if (!Number.isSafeInteger(timeout) || (timeout as number) <= 0) {
    return reject('invalid_channel_params', 'timeout must be a positive integer (seconds)');
  }
  return accept({
    addressA,
    addressB,
    asset,
    ...(salt === undefined ? {} : { salt: salt as string }),
    timeout: timeout as number,
  });
}

export function channelDefinition(params: ChannelParams): ChannelDefinition {
  // Key order matters for nothing (JSON source string sorts keys) but is kept
  // identical to aa-channels-lib for readability.
  const p: ChannelParams = {
    addressA: params.addressA,
    addressB: params.addressB,
    asset: params.asset,
    ...(params.salt === undefined ? {} : { salt: params.salt }),
    timeout: params.timeout,
  };
  return ['autonomous agent', { base_aa: CHANNEL_BASE_AA, params: p }];
}

export function channelAddress(params: ChannelParams): string {
  return obyte.utils.getChash160(channelDefinition(params) as unknown as unknown[]);
}

/**
 * Parses an on-chain AA definition and returns its channel parameters if it
 * is an instance of the supported base AA whose address matches `address`.
 */
export function parseChannelDefinition(
  address: string,
  definition: unknown,
): Verdict<ChannelParams> {
  if (
    !Array.isArray(definition) ||
    definition.length !== 2 ||
    definition[0] !== 'autonomous agent' ||
    !isPlainObject(definition[1])
  ) {
    return reject('invalid_channel_definition', 'Not a parameterized AA definition');
  }
  const body = definition[1];
  if (body['base_aa'] !== CHANNEL_BASE_AA) {
    return reject(
      'invalid_channel_definition',
      'AA is not an instance of the supported channel base AA',
    );
  }
  const params = validateChannelParams(body['params']);
  if (!params.ok) return params;
  if (channelAddress(params.value) !== address) {
    return reject('invalid_channel_definition', 'Definition does not match the channel address');
  }
  return params;
}
