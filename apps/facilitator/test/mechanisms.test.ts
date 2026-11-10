import { Writable } from 'node:stream';
import { createLogger } from '@obbyx/obyte/logger';
import { SqliteBatchStore, SqliteSettlementStore } from '@obbyx/x402-obyte';
import { describe, expect, it } from 'vitest';
import { loadFacilitatorConfig } from '../src/config.js';
import { buildMechanisms } from '../src/mechanisms.js';

describe('batch-settlement networks', () => {
  it('is served only where the channel base AA is deployed (testnet), and says why once', async () => {
    const logged: string[] = [];
    const logger = createLogger({
      destination: new Writable({ write: (chunk, _e, cb) => (logged.push(String(chunk)), cb()) }),
    });
    const store = new SqliteSettlementStore(':memory:');
    const { core, batch } = buildMechanisms({
      config: loadFacilitatorConfig({ NETWORKS: 'obyte:livenet,obyte:testnet' }),
      logger,
      store,
      clients: new Map(),
      batch: {
        store: new SqliteBatchStore(store.database),
        gateway: { health: () => ({ ok: true }), deliver: async () => ({ kind: 'timeout' }) },
      },
      bazaar: false,
    });
    expect(batch).toBeDefined();
    const kinds = core.getSupported().kinds.map((k) => `${k.scheme}@${k.network}`);
    expect(kinds).toContain('batch-settlement@obyte:testnet');
    expect(kinds).not.toContain('batch-settlement@obyte:livenet');
    expect(kinds).toContain('exact@obyte:livenet');
    const why = logged.filter((l) => l.includes('base AA v1.2 is not deployed'));
    expect(why).toHaveLength(1);
    expect(why[0]).toContain('obyte:livenet');
    await store.close();
  });

  it('a livenet-only facilitator serves no batch-settlement at all', async () => {
    const store = new SqliteSettlementStore(':memory:');
    const { core, batch } = buildMechanisms({
      config: loadFacilitatorConfig({ NETWORKS: 'obyte:livenet' }),
      logger: createLogger({ destination: new Writable({ write: (_c, _e, cb) => cb() }) }),
      store,
      clients: new Map(),
      batch: {
        store: new SqliteBatchStore(store.database),
        gateway: { health: () => ({ ok: true }), deliver: async () => ({ kind: 'timeout' }) },
      },
      bazaar: false,
    });
    expect(batch).toBeUndefined();
    expect(core.getSupported().kinds.map((k) => k.scheme)).not.toContain('batch-settlement');
    await store.close();
  });
});
