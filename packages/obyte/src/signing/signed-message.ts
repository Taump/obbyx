// Ambient types for obyte.js internals; a reference (not tsconfig "include") so that
// workspace packages compiling these sources via the @obbyx/source condition see them.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/obyte-internal.d.ts" />
import obyte from 'obyte';
import { getSignedPackageHashToSign, verify } from 'obyte/lib/internal.js';
import { isAddress } from '../channel/definition.js';
import type { ObyteNetwork } from '../core/networks.js';
import { type Verdict, accept, hasOnlyKeys, isPlainObject, reject } from '../core/result.js';

/**
 * Obyte signed messages ("signed packages") as used by AA payment channels.
 *
 * Supported profile (same as aa-channels-lib's light verifier, plus network
 * binding): exactly one author, an embedded `['sig', {pubkey}]` definition
 * whose chash equals the author address, signature under path `r`, and a
 * `version` that belongs to the expected network (testnet versions end in
 * `t`) — so a package can never be accepted on the other network (I4).
 *
 * Packages are signed with obyte.js directly:
 * `obyte.utils.signMessage(message, { privateKey, testnet })`.
 */
export type SigDefinition = readonly ['sig', { readonly pubkey: string }];

export interface SignedPackage<M = unknown> {
  version: string;
  signed_message: M;
  authors: [
    {
      address: string;
      definition: SigDefinition;
      authentifiers: { r: string };
    },
  ];
}

export interface VerifiedPackage<M = unknown> {
  readonly signer: string;
  readonly pubkey: string;
  readonly message: M;
}

export const SIGNED_PACKAGE_VERSIONS = {
  livenet: ['1.0', '2.0', '3.0', '4.0'],
  testnet: ['1.0t', '2.0t', '3.0t', '4.0t'],
} as const;

const PACKAGE_KEYS = new Set([
  'signed_message',
  'authors',
  'last_ball_unit',
  'timestamp',
  'version',
]);
const AUTHOR_KEYS = new Set(['address', 'definition', 'authentifiers']);

export function verifySignedPackage<M = unknown>(
  pkg: unknown,
  options: { network: ObyteNetwork; expectedSigner?: string },
): Verdict<VerifiedPackage<M>> {
  if (!isPlainObject(pkg)) return reject('invalid_signed_package', 'Package must be an object');
  if (!hasOnlyKeys(pkg, PACKAGE_KEYS)) {
    return reject('invalid_signed_package', 'Package has unexpected fields');
  }
  if (!('signed_message' in pkg)) {
    return reject('invalid_signed_package', 'Package has no signed_message');
  }
  const versions: readonly string[] = SIGNED_PACKAGE_VERSIONS[options.network.name];
  if (typeof pkg['version'] !== 'string' || !versions.includes(pkg['version'])) {
    return reject(
      'invalid_signed_package_network',
      `Package version is not valid for ${options.network.caip2}`,
    );
  }

  const authors = pkg['authors'];
  if (!Array.isArray(authors) || authors.length !== 1) {
    return reject('invalid_signed_package', 'Package must have exactly one author');
  }
  const author: unknown = authors[0];
  if (!isPlainObject(author) || !hasOnlyKeys(author, AUTHOR_KEYS)) {
    return reject('invalid_signed_package', 'Malformed author');
  }
  const address = author['address'];
  if (!isAddress(address)) return reject('invalid_signed_package', 'Invalid author address');
  if (options.expectedSigner !== undefined && address !== options.expectedSigner) {
    return reject('invalid_signed_package_signer', 'Package is signed by an unexpected address');
  }

  const definition = author['definition'];
  if (!isSigDefinition(definition)) {
    return reject(
      'invalid_signed_package_definition',
      "Only ['sig', {pubkey}] definitions are supported",
    );
  }
  let chash: string;
  try {
    chash = obyte.utils.getChash160([...definition]);
  } catch {
    return reject('invalid_signed_package_definition', 'Definition cannot be hashed');
  }
  if (chash !== address) {
    return reject('invalid_signed_package_definition', 'Definition does not match author address');
  }

  const authentifiers = author['authentifiers'];
  if (!isPlainObject(authentifiers) || Object.keys(authentifiers).length !== 1) {
    return reject('invalid_signed_package_signature', 'Expected a single authentifier "r"');
  }
  let hash: Uint8Array;
  try {
    hash = getSignedPackageHashToSign(pkg);
  } catch {
    return reject('invalid_signed_package', 'Package cannot be hashed');
  }
  if (!verifySignature(hash, authentifiers['r'], definition[1].pubkey)) {
    return reject('invalid_signed_package_signature', 'Signature is invalid');
  }

  return accept({
    signer: address,
    pubkey: definition[1].pubkey,
    message: pkg['signed_message'] as M,
  });
}

export function isSigDefinition(value: unknown): value is SigDefinition {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 'sig') return false;
  const params: unknown = value[1];
  return (
    isPlainObject(params) &&
    Object.keys(params).length === 1 &&
    typeof params['pubkey'] === 'string' &&
    params['pubkey'].length === 44
  );
}

/** secp256k1 verification that never throws on malformed input. */
export function verifySignature(hash: Uint8Array, signature: unknown, pubkey: string): boolean {
  if (typeof signature !== 'string') return false;
  try {
    return verify(hash, signature, pubkey);
  } catch {
    return false;
  }
}
