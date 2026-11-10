import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ObbyxError } from '@obbyx/obyte';

/**
 * Encryption at rest for client-signed channel packages (ADR-0001: anyone who
 * holds a package with a higher amount can submit a fraud proof and take the
 * channel balance, so a copy of the database must not reveal them).
 *
 * AES-256-GCM, a fresh 96-bit IV per package; the package hash is the
 * associated data, so a ciphertext cannot be moved to another row.
 * Format: `enc:v1:<iv>:<tag>:<ciphertext>` (base64url).
 */
const PREFIX = 'enc:v1:';

export class PackageCipher {
  private constructor(private readonly key: Buffer) {}

  static fromKey(key: Buffer): PackageCipher {
    if (key.length !== 32) throw new ObbyxError('invalid_config', 'Package key must be 32 bytes');
    return new PackageCipher(key);
  }

  /**
   * Loads the key file. A missing file is created (32 random bytes, mode 0600)
   * only when `create` is set (the database holds no package yet). A file
   * readable by group/others is refused.
   */
  static fromFile(path: string, options: { create: boolean }): PackageCipher {
    if (!existsSync(path)) {
      if (!options.create) {
        throw new ObbyxError(
          'invalid_config',
          `PACKAGE_KEY_FILE ${path} does not exist, but the database already holds encrypted channel packages: restore the original key file (a new key could never decrypt them).`,
        );
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      } catch (err) {
        throw new ObbyxError(
          'invalid_config',
          `Cannot create PACKAGE_KEY_FILE ${path} (${(err as Error).message}); create it yourself (32 random bytes, base64, mode 0600) on a read-only mount.`,
        );
      }
    }
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new ObbyxError('invalid_config', `${path} must not be readable by others (chmod 600)`);
    }
    return PackageCipher.fromKey(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
  }

  encrypt(plaintext: string, packageHash: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(packageHash));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const b = (x: Buffer) => x.toString('base64url');
    return `${PREFIX}${b(iv)}:${b(cipher.getAuthTag())}:${b(ct)}`;
  }

  /** Fails closed: a wrong key or a tampered row throws. */
  decrypt(stored: string, packageHash: string): string {
    if (!stored.startsWith(PREFIX)) {
      throw new ObbyxError('package_not_encrypted', 'Stored channel package is not encrypted');
    }
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
    if (iv === undefined || tag === undefined || ct === undefined) {
      throw new ObbyxError('package_corrupt', 'Malformed encrypted channel package');
    }
    try {
      const ivBytes = Buffer.from(iv, 'base64url');
      const tagBytes = Buffer.from(tag, 'base64url');
      // Without authTagLength Node accepts truncated tags (down to 4 bytes).
      if (ivBytes.length !== 12 || tagBytes.length !== 16) throw new Error('bad iv/tag length');
      const d = createDecipheriv('aes-256-gcm', this.key, ivBytes, { authTagLength: 16 });
      d.setAAD(Buffer.from(packageHash));
      d.setAuthTag(tagBytes);
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new ObbyxError(
        'package_corrupt',
        'Cannot decrypt a channel package (wrong PACKAGE_KEY_FILE or a tampered row)',
      );
    }
  }
}
