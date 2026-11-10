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
 * Obyte signed messages ("signed packages"). Every package has exactly one
 * author with an embedded `['sig', {pubkey}]` definition whose chash equals
 * the author address, a signature under path `r`, and a `version` of the
 * expected network (testnet versions end in `t`), so a package is never
 * accepted on the other network (I4). Two profiles:
 *
 * - {@link verifySignedPackage}: off-chain messages (login, receipts); also
 *   allows `last_ball_unit`, `timestamp` and version `1.0`.
 * - {@link verifyVoucherPackage}: channel vouchers. A strict SUBSET of what
 *   ocore's `is_valid_signed_package` accepts in the channel AA: only the keys
 *   `signed_message`, `authors`, `version`, versions `2.0`–`4.0`, one `sig`
 *   author with an embedded definition, no `last_ball_unit`. Any other key
 *   fails that check, and a `last_ball_unit` makes it fail for any payer whose
 *   address is already defined; a voucher the AA rejects can never be used in
 *   a close or a fraud proof, so it must never be accepted as a payment.
 *
 * Packages are signed with obyte.js directly:
 * `obyte.utils.signMessage(message, { privateKey, testnet })` (version 4.0).
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

interface Profile {
  readonly keys: ReadonlySet<string>;
  readonly versions: Readonly<Record<ObyteNetwork['name'], readonly string[]>>;
}

const MESSAGE_PROFILE: Profile = {
  keys: new Set(['signed_message', 'authors', 'last_ball_unit', 'timestamp', 'version']),
  versions: SIGNED_PACKAGE_VERSIONS,
};

const VOUCHER_PROFILE: Profile = {
  keys: new Set(['signed_message', 'authors', 'version']),
  versions: { livenet: ['2.0', '3.0', '4.0'], testnet: ['2.0t', '3.0t', '4.0t'] },
};

const AUTHOR_KEYS = new Set(['address', 'definition', 'authentifiers']);

interface VerifyOptions {
  network: ObyteNetwork;
  expectedSigner?: string;
}

/** An off-chain signed message (login, receipts). */
export function verifySignedPackage<M = unknown>(
  pkg: unknown,
  options: VerifyOptions,
): Verdict<VerifiedPackage<M>> {
  return verifyPackage<M>(pkg, options, MESSAGE_PROFILE);
}

/** A channel voucher: only a package the channel AA's `is_valid_signed_package` accepts. */
export function verifyVoucherPackage<M = unknown>(
  pkg: unknown,
  options: VerifyOptions,
): Verdict<VerifiedPackage<M>> {
  return verifyPackage<M>(pkg, options, VOUCHER_PROFILE);
}

function verifyPackage<M>(
  pkg: unknown,
  options: VerifyOptions,
  profile: Profile,
): Verdict<VerifiedPackage<M>> {
  if (!isPlainObject(pkg)) return reject('invalid_signed_package', 'Package must be an object');
  if (!hasOnlyKeys(pkg, profile.keys)) {
    return reject('invalid_signed_package', 'Package has unexpected fields');
  }
  if (!('signed_message' in pkg)) {
    return reject('invalid_signed_package', 'Package has no signed_message');
  }
  const versions = profile.versions[options.network.name];
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
