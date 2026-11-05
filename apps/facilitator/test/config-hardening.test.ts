import { describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../src/config.js';

describe('facilitator config hardening', () => {
  it('defaults the channel dispute window above the normal stabilization lag', () => {
    expect(loadFacilitatorConfig({}).batch.minChannelTimeoutSeconds).toBeGreaterThanOrEqual(
      4 * 3600,
    );
  });

  it.each([
    ['a hub URL that is not ws(s)/http(s)', { HUB_URL_TESTNET: 'ftp://hub.example' }],
    ['a facilitator address typo', { FACILITATOR_ADDRESSES: 'NOT-AN-ADDRESS' }],
    ['the same network twice', { NETWORKS: 'obyte:testnet,obyte-testnet' }],
    ['a timer interval that overflows', { RECOVERY_INTERVAL_MS: '3000000000' }],
  ])('refuses %s', (_name, env) => {
    expect(() => loadFacilitatorConfig(env)).toThrow();
  });

  it('accepts wss hub URLs', () => {
    expect(
      loadFacilitatorConfig({ HUB_URL_TESTNET: 'wss://hub.example/bb-test' }).networks[0]?.hubUrl,
    ).toBe('wss://hub.example/bb-test');
  });
});
