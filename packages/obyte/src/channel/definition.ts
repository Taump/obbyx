import obyte from 'obyte';
import { type Verdict, accept, isPlainObject, reject } from '../core/result.js';

/**
 * AA payment channels on our base AA v1.2 (aa/channels_base_aa_1.2.oscript),
 * a fork of the aa-channels-lib base AA v1.1 with the fraud-proof payout fixed.
 *
 * Party A is the payee (seller, x402 `payTo`), party B the payer (client).
 * A channel address is derived from its parameters, so binding a payment to a
 * seller is a matter of recomputing the address (ADR-0003): parameters are
 * taken from the on-chain definition, never trusted from a package alone.
 *
 * v1.2 pays a fraud proof to the wronged party (the one that did not start the
 * close). v1.1 paid it to whoever submitted it, so a client could close
 * understating its spending and "prove" its own lie to take the whole channel.
 */
export const CHANNEL_BASE_AA = '7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR';

/**
 * The networks (CAIP-2) where {@link CHANNEL_BASE_AA} is deployed: testnet
 * only for now. Channels are neither offered nor accepted anywhere else.
 */
export const CHANNEL_BASE_AA_NETWORKS: ReadonlySet<string> = new Set(['obyte:testnet']);

/**
 * Earlier base AAs. Channels on them are never opened or paid into; they are
 * recognised only so that existing channels can still be closed and defended.
 */
export const LEGACY_CHANNEL_BASE_AAS: readonly string[] = [
  '4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ', // v1.1, the aa-channels-lib original (mainnet and testnet)
];

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

export function channelDefinition(
  params: ChannelParams,
  baseAa: string = CHANNEL_BASE_AA,
): ChannelDefinition {
  // Key order matters for nothing (JSON source string sorts keys) but is kept
  // identical to aa-channels-lib for readability.
  const p: ChannelParams = {
    addressA: params.addressA,
    addressB: params.addressB,
    asset: params.asset,
    ...(params.salt === undefined ? {} : { salt: params.salt }),
    timeout: params.timeout,
  };
  return ['autonomous agent', { base_aa: baseAa, params: p }];
}

export function channelAddress(params: ChannelParams, baseAa: string = CHANNEL_BASE_AA): string {
  return obyte.utils.getChash160(channelDefinition(params, baseAa) as unknown as unknown[]);
}

export interface ParsedChannel {
  readonly baseAa: string;
  /** True for a channel on one of {@link LEGACY_CHANNEL_BASE_AAS}: close/defend only. */
  readonly legacy: boolean;
  readonly params: ChannelParams;
}

/**
 * Parses an on-chain AA definition of a channel on the current OR a legacy
 * base AA. Use only where existing channels are closed or defended; anything
 * that accepts payments must use {@link parseChannelDefinition}.
 */
export function parseAnyChannelDefinition(
  address: string,
  definition: unknown,
): Verdict<ParsedChannel> {
  if (
    !Array.isArray(definition) ||
    definition.length !== 2 ||
    definition[0] !== 'autonomous agent' ||
    !isPlainObject(definition[1])
  ) {
    return reject('invalid_channel_definition', 'Not a parameterized AA definition');
  }
  const body = definition[1];
  const baseAa = body['base_aa'];
  if (
    typeof baseAa !== 'string' ||
    (baseAa !== CHANNEL_BASE_AA && !LEGACY_CHANNEL_BASE_AAS.includes(baseAa))
  ) {
    return reject(
      'invalid_channel_definition',
      'AA is not an instance of the supported channel base AA',
    );
  }
  const params = validateChannelParams(body['params']);
  if (!params.ok) return params;
  if (channelAddress(params.value, baseAa) !== address) {
    return reject('invalid_channel_definition', 'Definition does not match the channel address');
  }
  return accept({ baseAa, legacy: baseAa !== CHANNEL_BASE_AA, params: params.value });
}

/**
 * Parses an on-chain AA definition and returns its channel parameters if it
 * is an instance of the CURRENT base AA ({@link CHANNEL_BASE_AA}) whose
 * address matches `address`. Legacy channels are refused.
 */
export function parseChannelDefinition(
  address: string,
  definition: unknown,
): Verdict<ChannelParams> {
  const parsed = parseAnyChannelDefinition(address, definition);
  if (!parsed.ok) return parsed;
  if (parsed.value.legacy) {
    return reject(
      'invalid_channel_definition',
      'AA is an instance of a retired channel base AA (v1.1); open a new channel',
    );
  }
  return accept(parsed.value.params);
}
