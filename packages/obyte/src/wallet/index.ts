import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import obyte from 'obyte';
import { z } from 'zod';
import { isAddress } from '../channel/definition.js';
import { ObbyxError } from '../core/errors.js';
import type { ObyteNetwork } from '../core/networks.js';

/**
 * Local single-address wallet shared by the CLI, the seller watcher and the
 * demo playground: one private key per network in
 * `$OBBYX_HOME/wallet-<network>.json` (default ~/.obbyx), file mode 0600.
 * Loading verifies the file (schema), its permissions, its network and that
 * the key derives the stored address. The key never leaves this machine.
 */
export const walletFileSchema = z
  .object({
    version: z.literal(1),
    network: z.string(),
    address: z.string().refine(isAddress, 'invalid Obyte address'),
    wif: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();

export type WalletFile = z.infer<typeof walletFileSchema>;

export function obbyxHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['OBBYX_HOME'] ?? join(homedir(), '.obbyx');
}

export function walletPath(network: ObyteNetwork, env: NodeJS.ProcessEnv = process.env): string {
  return join(obbyxHome(env), `wallet-${network.name}.json`);
}

export function createWallet(
  network: ObyteNetwork,
  opts: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): WalletFile {
  const path = walletPath(network, opts.env);
  if (existsSync(path) && opts.force !== true) {
    throw new ObbyxError(
      'wallet_exists',
      `A wallet already exists at ${path} (use --force to replace it)`,
    );
  }
  let privateKey: Uint8Array;
  let address: string;
  for (;;) {
    privateKey = randomBytes(32);
    try {
      address = addressOfKey(privateKey, network); // rejects the (astronomically unlikely) invalid scalar
      break;
    } catch {
      continue;
    }
  }
  const wallet: WalletFile = {
    version: 1,
    network: network.caip2,
    address,
    wif: obyte.utils.toWif(privateKey, network.testnet),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(obbyxHome(opts.env), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return wallet;
}

export function loadWallet(
  network: ObyteNetwork,
  env: NodeJS.ProcessEnv = process.env,
): WalletFile & { privateKey: Uint8Array } {
  const path = walletPath(network, env);
  if (!existsSync(path)) {
    throw new ObbyxError(
      'no_wallet',
      `No wallet for ${network.caip2}. Run: obbyx init --network ${network.name}`,
    );
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new ObbyxError(
      'wallet_permissions',
      `${path} is readable by others; run: chmod 600 ${path}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ObbyxError('wallet_corrupt', `${path} is not valid JSON`);
  }
  const parsed = walletFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ObbyxError(
      'wallet_corrupt',
      `${path}: ${parsed.error.issues[0]?.message ?? 'invalid wallet file'}`,
    );
  }
  const wallet = parsed.data;
  if (wallet.network !== network.caip2) {
    throw new ObbyxError('wallet_network', `${path} belongs to ${wallet.network}`);
  }
  let privateKey: Uint8Array;
  try {
    privateKey = obyte.utils.fromWif(wallet.wif, network.testnet).privateKey as Uint8Array;
  } catch {
    throw new ObbyxError('wallet_corrupt', `${path}: invalid key for ${network.caip2}`);
  }
  const address = addressOfKey(privateKey, network);
  if (address !== wallet.address)
    throw new ObbyxError('wallet_corrupt', `${path}: key does not match address`);
  return { ...wallet, privateKey };
}

/** Address of a single-sig key, via obyte.js public API (signMessage reports its author). */
export function addressOfKey(privateKey: Uint8Array, network: ObyteNetwork): string {
  const signed = obyte.utils.signMessage('obbyx', {
    privateKey,
    testnet: network.testnet,
  }) as unknown as {
    authors: { address: string }[];
  };
  const address = signed.authors[0]?.address;
  if (address === undefined) throw new ObbyxError('wallet_corrupt', 'Cannot derive address');
  return address;
}
