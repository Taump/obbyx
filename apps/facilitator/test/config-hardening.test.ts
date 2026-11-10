import { describe, expect, it } from 'vitest';
import { loadFacilitatorConfig, packageKeyNextToDb } from '../src/config.js';

describe('facilitator config hardening', () => {
  it.each([
    ['a hub URL that is not ws(s)/http(s)', { HUB_URL_TESTNET: 'ftp://hub.example' }],
    ['a facilitator address typo', { FACILITATOR_ADDRESSES: 'NOT-AN-ADDRESS' }],
    ['the same network twice', { NETWORKS: 'obyte:testnet,obyte-testnet' }],
    ['a timer interval that overflows', { RECOVERY_INTERVAL_MS: '3000000000' }],
  ])('refuses %s', (_name, env) => {
    expect(() => loadFacilitatorConfig(env)).toThrow();
  });

  it('keeps the default dispute window and refuses one below 1 h', () => {
    expect(loadFacilitatorConfig({}).batch.minChannelTimeoutSeconds).toBe(14_400);
    expect(() => loadFacilitatorConfig({ MIN_CHANNEL_TIMEOUT_SECONDS: '3599' })).toThrow(
      /MIN_CHANNEL_TIMEOUT_SECONDS/,
    );
    expect(() => loadFacilitatorConfig({ MIN_CHANNEL_TIMEOUT_SECONDS: '60' })).toThrow();
    expect(
      loadFacilitatorConfig({ MIN_CHANNEL_TIMEOUT_SECONDS: '3600' }).batch.minChannelTimeoutSeconds,
    ).toBe(3600);
  });

  it('production refuses to start without an explicit PACKAGE_KEY_FILE', () => {
    expect(() => loadFacilitatorConfig({ NODE_ENV: 'production' })).toThrow(/PACKAGE_KEY_FILE/);
    expect(() => loadFacilitatorConfig({ NODE_ENV: 'production', PACKAGE_KEY_FILE: ' ' })).toThrow(
      /PACKAGE_KEY_FILE/,
    );
    expect(
      loadFacilitatorConfig({ NODE_ENV: 'production', PACKAGE_KEY_FILE: '/etc/obbyx/package.key' })
        .packageKeyFile,
    ).toBe('/etc/obbyx/package.key');
    // outside production the default (next to the DB) still loads, for existing deployments
    expect(loadFacilitatorConfig({}).packageKeyFile).toBe('./data/package.key');
  });

  it('detects a package key file inside the database directory', () => {
    expect(packageKeyNextToDb(loadFacilitatorConfig({}))).toBe(true);
    expect(
      packageKeyNextToDb({
        dbPath: '/var/lib/obbyx/f.db',
        packageKeyFile: '/var/lib/obbyx/k/p.key',
      }),
    ).toBe(true);
    expect(
      packageKeyNextToDb({ dbPath: '/var/lib/obbyx/f.db', packageKeyFile: '/etc/obbyx/p.key' }),
    ).toBe(false);
    expect(
      packageKeyNextToDb({
        dbPath: '/var/lib/obbyx/f.db',
        packageKeyFile: '/var/lib/obbyx-keys/p.key',
      }),
    ).toBe(false);
    expect(packageKeyNextToDb({ dbPath: ':memory:', packageKeyFile: './data/package.key' })).toBe(
      false,
    );
  });

  it('accepts wss hub URLs', () => {
    expect(
      loadFacilitatorConfig({ HUB_URL_TESTNET: 'wss://hub.example/bb-test' }).networks[0]?.hubUrl,
    ).toBe('wss://hub.example/bb-test');
  });
});
