// Ambient types for obyte.js internals (declaration only, no code).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../obyte/src/types/obyte-internal.d.ts" />
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import obyte from 'obyte';
import {
  chashGetChash160,
  getSourceString,
  sign,
  toPublicKey,
  verify,
} from 'obyte/lib/internal.js';
import { ObbyxError } from '@obbyx/obyte';
import { startHeartbeat } from '@obbyx/x402-obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';

/**
 * Minimal Obyte device-messaging client (the encrypted chat used by wallets
 * and bots), enough to pair with a bot and exchange text messages.
 * Transport: obyte.js `Client` directly (`api.tempPubkey`, `api.getTempPubkey`,
 * `api.deliver`, `justsaying`, `subscribe`). Crypto mirrors ocore device.js:
 *
 * - login: sign {challenge, pubkey} → justsaying `hub/login`
 * - temp key: sign {temp_pubkey, pubkey} → request `hub/temp_pubkey`
 * - encryption: ECDH(secp256k1) x-coordinate → sha256 → first 16 bytes →
 *   AES-128-GCM with a random 12-byte IV
 * - device address: '0' + chash160("s\0" + base64 pubkey)
 */
export interface DeviceKey {
  readonly priv: Uint8Array;
  readonly pub: string;
}

export interface IncomingMessage {
  readonly from: string;
  readonly fromPubkey: string;
  readonly subject: string;
  readonly body: unknown;
}

export function newDeviceKey(): DeviceKey {
  for (;;) {
    const priv = randomBytes(32);
    try {
      return { priv, pub: toPublicKey(priv) };
    } catch {
      // invalid scalar, retry
    }
  }
}

export function deviceKeyFrom(priv: Uint8Array): DeviceKey {
  return { priv, pub: toPublicKey(priv) };
}

/** ocore object_hash.getDeviceAddress: '0' + chash160("s\0" + pubkey) (source-string form of a string). */
export function deviceAddress(pubkey: string): string {
  return `0${chashGetChash160(`s\x00${pubkey}`)}`;
}

/** sha256 of the source string with nulls removed and without `signature` (ocore getDeviceMessageHashToSign). */
export function deviceMessageHashToSign(message: Record<string, unknown>): Uint8Array {
  const naked = { ...message };
  delete naked['signature'];
  return createHash('sha256')
    .update(getSourceString(cleanNullsDeep(naked)), 'utf8')
    .digest();
}

function cleanNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanNullsDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, cleanNullsDeep(v)]),
    );
  }
  return value;
}

export function signDeviceMessage<T extends Record<string, unknown>>(
  message: T,
  key: DeviceKey,
): T & { signature: string } {
  return { ...message, signature: sign(deviceMessageHashToSign(message), key.priv) };
}

export function sharedSecret(peerPubkey: string, priv: Uint8Array): Buffer {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(priv));
  const x = ecdh.computeSecret(Buffer.from(peerPubkey, 'base64'));
  return createHash('sha256').update(x).digest().subarray(0, 16);
}

export interface EncryptedPackage {
  encrypted_message: string;
  iv: string;
  authtag: string;
  dh: { sender_ephemeral_pubkey: string; recipient_ephemeral_pubkey: string };
}

export function encryptPackage(json: unknown, recipientPubkey: string): EncryptedPackage {
  const ephemeral = newDeviceKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', sharedSecret(recipientPubkey, ephemeral.priv), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final()]);
  return {
    encrypted_message: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authtag: cipher.getAuthTag().toString('base64'),
    dh: { sender_ephemeral_pubkey: ephemeral.pub, recipient_ephemeral_pubkey: recipientPubkey },
  };
}

export function decryptPackage(pkg: EncryptedPackage, keys: readonly DeviceKey[]): unknown {
  const key = keys.find((k) => k.pub === pkg.dh.recipient_ephemeral_pubkey);
  if (key === undefined)
    throw new ObbyxError('device_unknown_key', 'Message encrypted to an unknown key');
  const decipher = createDecipheriv(
    'aes-128-gcm',
    sharedSecret(pkg.dh.sender_ephemeral_pubkey, key.priv),
    Buffer.from(pkg.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(pkg.authtag, 'base64'));
  const text = Buffer.concat([
    decipher.update(Buffer.from(pkg.encrypted_message, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const json = JSON.parse(text) as { encrypted_package?: EncryptedPackage };
  return json.encrypted_package === undefined ? json : decryptPackage(json.encrypted_package, keys);
}

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;

export class DeviceSession {
  readonly address: string;
  private readonly temp: DeviceKey;
  private readonly listeners = new Set<(m: IncomingMessage) => void>();
  private readonly log: Logger;
  private readonly stopHeartbeat: () => void;

  private constructor(
    private readonly client: obyte.Client,
    private readonly key: DeviceKey,
    readonly hubHost: string,
    logger: Logger,
    temp: DeviceKey | undefined,
  ) {
    // The temp key is persisted by the caller (like ocore) so messages queued
    // at the hub for the previous session can still be decrypted.
    this.temp = temp ?? newDeviceKey();
    this.address = deviceAddress(key.pub);
    this.stopHeartbeat = startHeartbeat(client);
    this.log = moduleLogger(logger, 'device', { device: this.address });
  }

  /** Connects to `wss://<hubHost>`, logs in with the permanent key and registers a temp key. */
  static async connect(options: {
    hubHost: string;
    testnet: boolean;
    key: DeviceKey;
    /** Persisted temp key; a fresh one is generated when omitted. */
    tempKey?: DeviceKey;
    logger: Logger;
    timeoutMs?: number;
  }): Promise<DeviceSession> {
    const client = new obyte.Client(`wss://${options.hubHost}`, {
      testnet: options.testnet,
      reconnect: true,
    });
    const session = new DeviceSession(
      client,
      options.key,
      options.hubHost,
      options.logger,
      options.tempKey,
    );
    const firstLogin = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new ObbyxError('device_hub_timeout', `Could not log in to ${options.hubHost}`)),
        options.timeoutMs ?? 15_000,
      );
      // Per obyte.js: subscriptions and hub login live for ONE connection, so
      // everything per-connection is (re)done in onConnect after every reconnect.
      client.onConnect(() => {
        client.subscribe((_err, message: unknown) => {
          if (!Array.isArray(message) || message[0] !== 'justsaying') return;
          const { subject, body } = message[1] as { subject: string; body: unknown };
          if (subject === 'hub/challenge' && typeof body === 'string') {
            session.login(body).then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              (err: unknown) => session.log.error({ err }, 'hub login failed'),
            );
          } else if (subject === 'hub/message') {
            session.onHubMessage(body);
          }
        });
      });
    });
    try {
      await firstLogin;
    } catch (err) {
      session.close();
      throw err;
    }
    return session;
  }

  /** Answers the hub challenge and registers our temp key (every connection). */
  private async login(challenge: string): Promise<void> {
    this.client.justsaying(
      'hub/login',
      signDeviceMessage({ challenge, pubkey: this.key.pub }, this.key),
    );
    const res = await this.api(
      'tempPubkey',
      signDeviceMessage({ temp_pubkey: this.temp.pub, pubkey: this.key.pub }, this.key),
    );
    if (res !== 'updated') {
      throw new ObbyxError(
        'device_login_failed',
        `Hub did not accept the temp key: ${JSON.stringify(res)}`,
      );
    }
    this.log.info({ hub: this.hubHost }, 'logged in to hub');
  }

  onMessage(listener: (m: IncomingMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends {from, device_hub, subject, body} encrypted to the recipient's temp key. */
  async send(recipientPubkey: string, subject: string, body: unknown): Promise<void> {
    const temp = (await this.api('getTempPubkey', recipientPubkey)) as Record<string, unknown>;
    if (
      typeof temp?.['temp_pubkey'] !== 'string' ||
      temp['pubkey'] !== recipientPubkey ||
      typeof temp['signature'] !== 'string' ||
      !verify(deviceMessageHashToSign(temp), temp['signature'], recipientPubkey)
    ) {
      throw new ObbyxError(
        'device_bad_temp_key',
        'Recipient temp key is missing or not signed by the recipient',
      );
    }
    const json = { from: this.address, device_hub: this.hubHost, subject, body };
    const message = signDeviceMessage(
      {
        encrypted_package: encryptPackage(json, temp['temp_pubkey']),
        to: deviceAddress(recipientPubkey),
        pubkey: this.key.pub,
      },
      this.key,
    );
    const res = await this.api('deliver', message);
    if (res !== 'accepted')
      throw new ObbyxError(
        'device_send_failed',
        `Hub did not accept the message: ${JSON.stringify(res)}`,
      );
    this.log.debug({ to: deviceAddress(recipientPubkey), subject }, 'message delivered to hub');
  }

  close(): void {
    this.stopHeartbeat();
    this.client.close();
  }

  private async api(method: string, ...args: unknown[]): Promise<unknown> {
    try {
      const fn = (this.client.api as unknown as Api)[method];
      if (fn === undefined) throw new Error(`obyte.js has no api.${method}`);
      return await fn(...args);
    } catch (err) {
      throw new ObbyxError(
        'device_hub_error',
        `Hub request ${method} failed: ${typeof err === 'string' ? err : String(err)}`,
      );
    }
  }

  private onHubMessage(body: unknown): void {
    const { message_hash: hash, message } = (body ?? {}) as {
      message_hash?: string;
      message?: Record<string, unknown>;
    };
    if (typeof hash !== 'string' || message === undefined) return;
    const ack = () => this.client.justsaying('hub/delete', hash);
    try {
      const pubkey = message['pubkey'];
      if (
        message['to'] !== this.address ||
        typeof pubkey !== 'string' ||
        typeof message['signature'] !== 'string' ||
        !verify(deviceMessageHashToSign(message), message['signature'], pubkey)
      ) {
        this.log.warn('dropping a message with a bad signature or recipient');
        return ack();
      }
      const json = decryptPackage(message['encrypted_package'] as EncryptedPackage, [
        this.temp,
        this.key,
      ]) as {
        from?: string;
        subject?: string;
        body?: unknown;
      };
      if (json.from !== deviceAddress(pubkey)) {
        this.log.warn('dropping a message whose sender does not match its signature');
        return ack();
      }
      const incoming = {
        from: json.from,
        fromPubkey: pubkey,
        subject: String(json.subject),
        body: json.body,
      };
      for (const listener of this.listeners) listener(incoming);
    } catch (err) {
      this.log.warn({ err }, 'failed to process an incoming message');
    }
    ack();
  }
}
