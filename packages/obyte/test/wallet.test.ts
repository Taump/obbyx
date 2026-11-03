import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OBYTE_NETWORKS, isAddress } from '@obbyx/obyte';
import { describe, expect, it } from 'vitest';
import { addressOfKey, createWallet, loadWallet, walletPath } from '../src/wallet/index.js';

const env = () => ({ OBBYX_HOME: join(mkdtempSync(join(tmpdir(), 'obbyx-cli-')), 'home') });

describe('wallet file', () => {
  it('creates a private (0600) testnet wallet and loads the same key back', () => {
    const e = env();
    const created = createWallet(OBYTE_NETWORKS.testnet, { env: e });
    expect(isAddress(created.address)).toBe(true);
    expect(statSync(walletPath(OBYTE_NETWORKS.testnet, e)).mode & 0o777).toBe(0o600);
    const loaded = loadWallet(OBYTE_NETWORKS.testnet, e);
    expect(loaded.address).toBe(created.address);
    expect(addressOfKey(loaded.privateKey, OBYTE_NETWORKS.testnet)).toBe(created.address);
  });

  it('refuses to overwrite without --force', () => {
    const e = env();
    createWallet(OBYTE_NETWORKS.testnet, { env: e });
    expect(() => createWallet(OBYTE_NETWORKS.testnet, { env: e })).toThrow(/already exists/);
    expect(() => createWallet(OBYTE_NETWORKS.testnet, { env: e, force: true })).not.toThrow();
  });

  it('refuses a wallet file readable by others', () => {
    const e = env();
    createWallet(OBYTE_NETWORKS.testnet, { env: e });
    chmodSync(walletPath(OBYTE_NETWORKS.testnet, e), 0o644);
    expect(() => loadWallet(OBYTE_NETWORKS.testnet, e)).toThrow(/readable by others/);
  });

  it('keeps wallets per network', () => {
    const e = env();
    createWallet(OBYTE_NETWORKS.testnet, { env: e });
    expect(() => loadWallet(OBYTE_NETWORKS.livenet, e)).toThrow(/No wallet/);
  });
});

describe('wallet file validation', () => {
  const write = (e: { OBBYX_HOME: string }, content: string) => {
    const path = walletPath(OBYTE_NETWORKS.testnet, e);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };

  it('rejects invalid JSON, a wrong schema and a key that does not match the address', () => {
    const e = env();
    const good = createWallet(OBYTE_NETWORKS.testnet, { env: e });
    write(e, '{not json');
    expect(() => loadWallet(OBYTE_NETWORKS.testnet, e)).toThrow(/not valid JSON/);
    write(e, JSON.stringify({ ...good, extra: 1 }));
    expect(() => loadWallet(OBYTE_NETWORKS.testnet, e)).toThrow(/wallet_corrupt|Unrecognized/);
    const other = createWallet(OBYTE_NETWORKS.testnet, { env: env() });
    write(e, JSON.stringify({ ...good, wif: other.wif }));
    expect(() => loadWallet(OBYTE_NETWORKS.testnet, e)).toThrow(/does not match/);
    write(e, JSON.stringify({ ...good, network: 'obyte:livenet' }));
    expect(() => loadWallet(OBYTE_NETWORKS.testnet, e)).toThrow(/belongs to obyte:livenet/);
  });
});
