import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
   * Loads the key file, creating it (mode 0600) when missing. A file readable by
   * group/others is refused: the key protects funds.
   */
  static fromFile(path: string): PackageCipher {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      throw new ObbyxError('invalid_config', `${path} must not be readable by others (chmod 600)`);
    }
    chmodSync(path, 0o600);
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
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(packageHash));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new ObbyxError(
        'package_corrupt',
        'Cannot decrypt a channel package (wrong PACKAGE_KEY_FILE or a tampered row)',
      );
    }
  }
}
