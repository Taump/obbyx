import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, envBoolean, envPort, loadConfig } from '../src/config/index.js';
import {
  OBYTE_NETWORKS,
  UnsupportedNetworkError,
  getNetwork,
  isObyteNetwork,
  networkKey,
} from '../src/core/networks.js';

describe('networks', () => {
  it('resolves both CAIP-2 (v2) and v1 names to the same network', () => {
    expect(getNetwork('obyte:testnet')).toBe(OBYTE_NETWORKS.testnet);
    expect(getNetwork('obyte-testnet')).toBe(OBYTE_NETWORKS.testnet);
    expect(getNetwork('obyte:livenet').testnet).toBe(false);
  });

  it('rejects other networks', () => {
    expect(isObyteNetwork('eip155:8453')).toBe(false);
    expect(() => getNetwork('obyte:devnet')).toThrow(UnsupportedNetworkError);
  });

  it('keys are namespaced by network so the same proof differs across networks (I4)', () => {
    const a = networkKey(OBYTE_NETWORKS.testnet, 'unit', 'abc');
    const b = networkKey(OBYTE_NETWORKS.livenet, 'unit', 'abc');
    expect(a).toBe('obyte:testnet:unit:abc');
    expect(a).not.toBe(b);
    expect(() => networkKey(OBYTE_NETWORKS.testnet)).toThrow();
    expect(() => networkKey(OBYTE_NETWORKS.testnet, '')).toThrow();
  });
});

describe('loadConfig', () => {
  const schema = z.object({ PORT: envPort, DEBUG: envBoolean.default(false), HUB: z.url() });

  it('parses and coerces env values', () => {
    expect(loadConfig(schema, { PORT: '8080', HUB: 'wss://obyte.org/bb-test' })).toEqual({
      PORT: 8080,
      DEBUG: false,
      HUB: 'wss://obyte.org/bb-test',
    });
  });

  it('reports all problems at once', () => {
    try {
      loadConfig(schema, { PORT: '99999', DEBUG: 'maybe' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues).toHaveLength(3);
    }
  });
});
