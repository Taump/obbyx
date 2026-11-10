import { describe, expect, it } from 'vitest';
import vectors from './fixtures/testnet-vectors.json' with { type: 'json' };
import obyte from 'obyte';
import {
  getBase64Hash,
  getSignedPackageHashToSign,
  getUnitHash,
  getUnitHashToSign,
  sign as signHash,
  verify,
} from 'obyte/lib/internal.js';
import {
  CHANNEL_BASE_AA,
  LEGACY_CHANNEL_BASE_AAS,
  channelAddress,
  channelDefinition,
  parseAnyChannelDefinition,
  parseChannelDefinition,
} from '../src/channel/definition.js';
import { expectedCommissions } from '../src/unit/exact-unit.js';
import { OBYTE_NETWORKS } from '../src/core/networks.js';
import { verifySignedPackage, verifyVoucherPackage } from '../src/signing/signed-message.js';
import { addressOf, testKey } from './helpers.js';

/**
 * Conformance against real testnet ledger data (fixtures/testnet-vectors.json).
 * If an obyte.js upgrade changes hashing, these fail first (ADR-0006).
 */
describe('conformance with the Obyte testnet ledger', () => {
  const unit = vectors.unit;

  it('recomputes the unit hash of a real unit', () => {
    expect(getUnitHash(unit)).toBe(unit.unit);
  });

  it('recomputes payload hashes', () => {
    for (const m of unit.messages) expect(getBase64Hash(m.payload, true)).toBe(m.payload_hash);
  });

  it('verifies the author signature with the on-chain definition', () => {
    const { definition, address } = vectors.authorDefinition;
    const pubkey = (definition[1] as { pubkey: string }).pubkey;
    expect(obyte.utils.getChash160(definition)).toBe(address);
    expect(verify(getUnitHashToSign(unit), unit.authors[0]!.authentifiers.r, pubkey)).toBe(true);
  });

  it('computes the commissions ocore accepted for a signed unit', () => {
    expect(expectedCommissions(unit)).toEqual({
      headers: unit.headers_commission,
      payload: unit.payload_commission,
    });
  });

  it('recognises a real (v1.1) channel AA for closing only, never for payments', () => {
    const [, body] = vectors.channel.definition as [string, { base_aa: string; params: never }];
    expect(body.base_aa).toBe(LEGACY_CHANNEL_BASE_AAS[0]);
    expect(channelAddress(body.params, body.base_aa)).toBe(vectors.channel.address);
    const parsed = parseAnyChannelDefinition(vectors.channel.address, vectors.channel.definition);
    expect(parsed).toMatchObject({ ok: true, value: { legacy: true, baseAa: body.base_aa } });
    expect(
      parseChannelDefinition(vectors.channel.address, vectors.channel.definition),
    ).toMatchObject({ ok: false, reason: 'invalid_channel_definition' });
  });

  it('accepts a channel on the current base AA', () => {
    const [, body] = vectors.channel.definition as [string, { params: never }];
    const def = channelDefinition(body.params);
    expect(def[1].base_aa).toBe(CHANNEL_BASE_AA);
    expect(parseChannelDefinition(channelAddress(body.params), def)).toMatchObject({ ok: true });
    expect(parseAnyChannelDefinition(channelAddress(body.params), def)).toMatchObject({
      ok: true,
      value: { legacy: false },
    });
  });

  it('rejects a definition that does not match the channel address or base AA', () => {
    const tampered = structuredClone(vectors.channel.definition) as [
      string,
      { params: { timeout: number } },
    ];
    tampered[1].params.timeout = 999;
    expect(parseAnyChannelDefinition(vectors.channel.address, tampered)).toMatchObject({
      ok: false,
      reason: 'invalid_channel_definition',
    });
    const otherBase = structuredClone(vectors.channel.definition) as [string, { base_aa: string }];
    otherBase[1].base_aa = 'X'.repeat(32);
    expect(parseAnyChannelDefinition(vectors.channel.address, otherBase).ok).toBe(false);
  });
});

describe('signed packages', () => {
  const key = testKey('client');
  const testnet = OBYTE_NETWORKS.testnet;
  const signPackage = (msg: unknown, k: Uint8Array) =>
    obyte.utils.signMessage(msg, { privateKey: k, testnet: true });
  const message = {
    aa_address: 'X'.repeat(32),
    period: 1,
    amount_spent: 300000,
    binding: 'ab'.repeat(32),
  };

  it('round-trips with extra fields such as binding', () => {
    const pkg = signPackage(message, key);
    const res = verifySignedPackage(pkg, { network: testnet, expectedSigner: addressOf(key) });
    expect(res).toMatchObject({ ok: true, value: { signer: addressOf(key), message } });
  });

  it('cannot be replayed on the other network (I4)', () => {
    const pkg = signPackage(message, key);
    expect(verifySignedPackage(pkg, { network: OBYTE_NETWORKS.livenet })).toMatchObject({
      ok: false,
      reason: 'invalid_signed_package_network',
    });
  });

  it.each([
    [
      'tampered binding',
      (p: any) => (p.signed_message.binding = 'cd'.repeat(32)),
      'invalid_signed_package_signature',
    ],
    [
      'tampered amount',
      (p: any) => (p.signed_message.amount_spent += 1),
      'invalid_signed_package_signature',
    ],
    [
      'foreign definition',
      (p: any) => (p.authors[0].definition = ['sig', { pubkey: 'A'.repeat(44) }]),
      'invalid_signed_package_definition',
    ],
    [
      'multisig definition',
      (p: any) => (p.authors[0].definition = ['or', []]),
      'invalid_signed_package_definition',
    ],
    ['extra top-level field', (p: any) => (p.extra = 1), 'invalid_signed_package'],
    ['two authors', (p: any) => p.authors.push(p.authors[0]), 'invalid_signed_package'],
    [
      'extra authentifier',
      (p: any) => (p.authors[0].authentifiers.s = 'x'),
      'invalid_signed_package_signature',
    ],
    [
      'garbage signature',
      (p: any) => (p.authors[0].authentifiers.r = '!!'),
      'invalid_signed_package_signature',
    ],
  ])('rejects %s', (_name, mutate, reason) => {
    const pkg: any = structuredClone(signPackage(message, key));
    mutate(pkg);
    expect(verifySignedPackage(pkg, { network: testnet })).toMatchObject({ ok: false, reason });
  });

  it('rejects a package from an unexpected signer', () => {
    const pkg = signPackage(message, testKey('someone-else'));
    expect(
      verifySignedPackage(pkg, { network: testnet, expectedSigner: addressOf(key) }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_signed_package_signer',
    });
  });
});

describe('channel voucher packages (AA profile)', () => {
  const key = testKey('client');
  const testnet = OBYTE_NETWORKS.testnet;
  const sign = (msg: unknown) => obyte.utils.signMessage(msg, { privateKey: key, testnet: true });
  const message = { aa_address: 'X'.repeat(32), period: 1, amount_spent: 300000 };

  it('accepts what obyte.js signs (version 4.0t, three keys)', () => {
    const pkg = sign(message);
    expect(Object.keys(pkg).sort()).toEqual(['authors', 'signed_message', 'version']);
    expect(verifyVoucherPackage(pkg, { network: testnet })).toMatchObject({ ok: true });
  });

  /**
   * A package re-signed with fields that the AA's is_valid_signed_package
   * rejects: the signature is valid, so the loose profile accepts it, but the
   * seller could never use such a voucher in a close or a fraud proof.
   */
  const resigned = (mutate: (p: any) => void) => {
    const pkg: any = structuredClone(sign(message));
    mutate(pkg);
    delete pkg.authors[0].authentifiers;
    const hash = getSignedPackageHashToSign(pkg);
    pkg.authors[0].authentifiers = { r: signHash(hash, key) };
    return pkg;
  };

  it.each([
    ['a timestamp field', (p: any) => (p.timestamp = 0)],
    ['a last_ball_unit', (p: any) => (p.last_ball_unit = 'A'.repeat(43) + '=')],
    ['version 1.0t', (p: any) => (p.version = '1.0t')],
  ])('refuses a validly signed package with %s', (_name, mutate) => {
    const pkg = resigned(mutate);
    expect(verifySignedPackage(pkg, { network: testnet }).ok).toBe(true); // loose profile
    expect(verifyVoucherPackage(pkg, { network: testnet }).ok).toBe(false);
  });
});
