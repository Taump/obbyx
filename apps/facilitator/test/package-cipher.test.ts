import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PackageCipher } from '../src/storage/package-cipher.js';

describe('package cipher', () => {
  const cipher = PackageCipher.fromKey(randomBytes(32));

  it('round-trips and binds the ciphertext to the package hash', () => {
    const stored = cipher.encrypt('{"a":1}', 'h1');
    expect(cipher.decrypt(stored, 'h1')).toBe('{"a":1}');
    expect(() => cipher.decrypt(stored, 'h2')).toThrow(/Cannot decrypt/);
  });

  it('refuses a truncated authentication tag', () => {
    const stored = cipher.encrypt('{"a":1}', 'h1');
    const parts = stored.split(':');
    const tagIndex = parts.length - 2;
    parts[tagIndex] = Buffer.from(parts[tagIndex]!, 'base64url')
      .subarray(0, 4)
      .toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'), 'h1')).toThrow(/Cannot decrypt/);
  });
});
