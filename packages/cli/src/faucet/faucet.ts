import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import obyte from 'obyte';
import { ObbyxError, type ObyteNetwork } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import { type DeviceKey, DeviceSession, deviceKeyFrom, newDeviceKey } from './device.js';
import { obbyxHome } from '@obbyx/obyte/wallet';

/**
 * Testnet faucet over the Obyte bot protocol (byteball/obyte-faucet):
 * pair with the "Faucet Bot" listed by the testnet hub, send it our address,
 * read its answer. The bot pays 0.5–1 GBYTE once per 24 h per device.
 */
export type FaucetStatus = 'sent' | 'rate_limited' | 'rejected' | 'no_answer';

export interface FaucetResult {
  readonly status: FaucetStatus;
  readonly botMessages: readonly string[];
  readonly bot: string;
}

export interface PairingCode {
  readonly pubkey: string;
  readonly hub: string;
  readonly secret: string;
}

export function parsePairingCode(code: string): PairingCode {
  const m = /^([A-Za-z0-9+/]{43}[A-Za-z0-9+/=])@([\w.-]+(?:\/[\w.-]+)*)#(.+)$/.exec(code.trim());
  const [, pubkey, hub, secret] = m ?? [];
  if (pubkey === undefined || hub === undefined || secret === undefined) {
    throw new ObbyxError('bad_pairing_code', `Not a pairing code: ${code}`);
  }
  return { pubkey, hub, secret };
}

/** Classifies the faucet bot's replies (texts from byteball/obyte-faucet start.js). */
export function classifyFaucetReply(text: string): FaucetStatus | undefined {
  if (/only once per 24 hours/i.test(text)) return 'rate_limited';
  if (/valid address|unrecognized command/i.test(text)) return 'rejected';
  if (/blackbytes/i.test(text)) return 'sent'; // sent after a successful payout
  return undefined;
}

/**
 * Device keys for the CLI (`$OBBYX_HOME/device-<network>.json`, mode 0600):
 * the permanent key (identity towards bots) and the temp key used for
 * encryption, both kept across sessions like ocore does.
 */
export function loadOrCreateDeviceKeys(
  network: ObyteNetwork,
  env: NodeJS.ProcessEnv = process.env,
): { key: DeviceKey; temp: DeviceKey } {
  const path = join(obbyxHome(env), `device-${network.name}.json`);
  const stored = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { priv: string; tempPriv?: string })
    : undefined;
  const key = stored ? deviceKeyFrom(Buffer.from(stored.priv, 'base64')) : newDeviceKey();
  const temp = stored?.tempPriv
    ? deviceKeyFrom(Buffer.from(stored.tempPriv, 'base64'))
    : newDeviceKey();
  if (stored?.tempPriv === undefined) {
    mkdirSync(obbyxHome(env), { recursive: true, mode: 0o700 });
    const body = {
      priv: Buffer.from(key.priv).toString('base64'),
      tempPriv: Buffer.from(temp.priv).toString('base64'),
    };
    writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return { key, temp };
}

export async function requestFromFaucet(options: {
  network: ObyteNetwork;
  address: string;
  logger: Logger;
  timeoutMs?: number;
  onBotText?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<FaucetResult> {
  if (!options.network.testnet)
    throw new ObbyxError('faucet_testnet_only', 'The faucet is available on testnet only');
  const log = moduleLogger(options.logger, 'faucet');

  // 1. Find the faucet bot in the hub's bot directory.
  const directory = new obyte.Client(options.network.defaultHubUrl, { testnet: true });
  let code: PairingCode;
  let botName: string;
  try {
    const bots = await directory.api.getBots();
    const bot = bots.find((b) => /faucet/i.test(b.name));
    if (bot === undefined)
      throw new ObbyxError('faucet_not_found', 'No faucet bot listed by the testnet hub');
    code = parsePairingCode(bot.pairing_code);
    botName = bot.name;
  } finally {
    directory.close();
  }
  log.info({ bot: botName, hub: code.hub }, 'faucet bot found');

  // 2. Log in to the bot's hub with our device key.
  const { key, temp } = loadOrCreateDeviceKeys(options.network, options.env);
  const session = await DeviceSession.connect({
    hubHost: code.hub,
    testnet: true,
    key,
    tempKey: temp,
    logger: options.logger,
  });
  const texts: string[] = [];
  try {
    const result = new Promise<FaucetStatus>((resolve) => {
      const timer = setTimeout(() => resolve('no_answer'), options.timeoutMs ?? 60_000);
      session.onMessage((m) => {
        if (m.fromPubkey !== code.pubkey || m.subject !== 'text' || typeof m.body !== 'string')
          return;
        texts.push(m.body);
        options.onBotText?.(m.body);
        const status = classifyFaucetReply(m.body);
        if (status !== undefined) {
          clearTimeout(timer);
          resolve(status);
        }
      });
    });

    // 3. Pair, then send our address.
    await session.send(code.pubkey, 'pairing', {
      pairing_secret: code.secret,
      device_name: 'obbyx-cli',
      reverse_pairing_secret: randomBytes(9).toString('base64'),
    });
    await session.send(code.pubkey, 'text', options.address);
    log.info({ address: options.address }, 'address sent to the faucet');
    return { status: await result, botMessages: texts, bot: botName };
  } finally {
    session.close();
  }
}
