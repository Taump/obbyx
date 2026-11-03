import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptPackage,
  deviceAddress,
  deviceKeyFrom,
  deviceMessageHashToSign,
  encryptPackage,
  sharedSecret,
  signDeviceMessage,
} from '../src/faucet/device.js';
import { classifyFaucetReply, parsePairingCode } from '../src/faucet/faucet.js';
import { verify } from 'obyte/lib/internal.js';

/** Vectors computed with ocore (object_hash.js, secp256k1 ecdh) — see ADR-0006 conformance approach. */
const OCORE = {
  pub: 'AlA7VSjQK4EET7WW5a0QNpif3SeSSfwBMxth/ecMsRmT',
  peerPub: 'AiPif5gsKqoi+MKu3nLpyqzNY1wT8IGus7SMTdGD67fT',
  deviceAddress: '07PQ3JAJ4YXOXNMPTUARWLC4CEYXQPFRZ',
  faucetDeviceAddress: '0TFZHX7UTVQUWEPGLQDWEV5A4KLHFA5WB',
  sharedSecretHex: 'e04a43bd6803440ea2c5a27d953f3685',
  hashToSignHex: '986facd6a1ac11bb2531eb43af3840bbe395b086e8cbddfb9db86df7c8e1dc38',
};
const key = (label: string) => deviceKeyFrom(createHash('sha256').update(label).digest());
const a = key('obbyx-device-a');
const b = key('obbyx-device-b');

describe('device protocol conformance with ocore', () => {
  it('derives the same public keys and device addresses', () => {
    expect(a.pub).toBe(OCORE.pub);
    expect(b.pub).toBe(OCORE.peerPub);
    expect(deviceAddress(a.pub)).toBe(OCORE.deviceAddress);
    expect(deviceAddress('AxBxXDnPOzE/AxLHmidAjwLPFtQ6dK3k70zM0yKVeDzC')).toBe(
      OCORE.faucetDeviceAddress,
    );
  });

  it('computes the same ECDH shared secret', () => {
    expect(sharedSecret(b.pub, a.priv).toString('hex')).toBe(OCORE.sharedSecretHex);
    expect(sharedSecret(a.pub, b.priv).toString('hex')).toBe(OCORE.sharedSecretHex);
  });

  it('computes the same hash to sign (nulls removed, signature excluded)', () => {
    const msg = { challenge: 'abc', pubkey: a.pub, extra: null, nested: { a: 1, n: null } };
    expect(Buffer.from(deviceMessageHashToSign(msg)).toString('hex')).toBe(OCORE.hashToSignHex);
    const signed = signDeviceMessage(msg, a);
    expect(Buffer.from(deviceMessageHashToSign(signed)).toString('hex')).toBe(OCORE.hashToSignHex);
    expect(verify(deviceMessageHashToSign(signed), signed.signature, a.pub)).toBe(true);
  });
});

describe('encryption', () => {
  it('round-trips to the recipient key and fails for others', () => {
    const json = { from: deviceAddress(a.pub), subject: 'text', body: 'hello' };
    const pkg = encryptPackage(json, b.pub);
    expect(decryptPackage(pkg, [b])).toEqual(json);
    expect(() => decryptPackage(pkg, [a])).toThrow(/unknown key/);
    const tampered = { ...pkg, encrypted_message: Buffer.from('x').toString('base64') };
    expect(() => decryptPackage(tampered, [b])).toThrow();
  });
});

describe('faucet helpers', () => {
  it('parses the faucet pairing code from the testnet hub', () => {
    expect(
      parsePairingCode('AxBxXDnPOzE/AxLHmidAjwLPFtQ6dK3k70zM0yKVeDzC@byteball.org/bb-test#0000'),
    ).toEqual({
      pubkey: 'AxBxXDnPOzE/AxLHmidAjwLPFtQ6dK3k70zM0yKVeDzC',
      hub: 'byteball.org/bb-test',
      secret: '0000',
    });
    expect(() => parsePairingCode('nonsense')).toThrow();
  });

  it('classifies the faucet bot replies', () => {
    expect(
      classifyFaucetReply(
        'If you\'d like to also receive free blackbytes, type "blackbytes to YOURADDRESS"',
      ),
    ).toBe('sent');
    expect(
      classifyFaucetReply(
        "You can request free bytes only once per 24 hours.  I've already sent you 500000 bytes",
      ),
    ).toBe('rate_limited');
    expect(classifyFaucetReply('Please send a valid address')).toBe('rejected');
    expect(
      classifyFaucetReply('To receive free bytes, let me know your Obyte address'),
    ).toBeUndefined();
  });
});

describe('device key persistence', () => {
  it('keeps the permanent and temp keys across sessions (0600)', async () => {
    const { mkdtempSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { OBYTE_NETWORKS } = await import('@obbyx/obyte');
    const { loadOrCreateDeviceKeys } = await import('../src/faucet/faucet.js');
    const env = { OBBYX_HOME: join(mkdtempSync(join(tmpdir(), 'obbyx-dev-')), 'home') };
    const first = loadOrCreateDeviceKeys(OBYTE_NETWORKS.testnet, env);
    const second = loadOrCreateDeviceKeys(OBYTE_NETWORKS.testnet, env);
    expect(second.key.pub).toBe(first.key.pub);
    expect(second.temp.pub).toBe(first.temp.pub);
    expect(first.temp.pub).not.toBe(first.key.pub);
    expect(statSync(join(env.OBBYX_HOME, 'device-testnet.json')).mode & 0o777).toBe(0o600);
  });
});
