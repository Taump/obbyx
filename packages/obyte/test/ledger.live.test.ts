import obyte from 'obyte';
import { getUnitHash } from 'obyte/lib/internal.js';
import { afterAll, describe, expect, it } from 'vitest';
import vectors from './fixtures/testnet-vectors.json' with { type: 'json' };
import { parseChannelDefinition } from '../src/channel/definition.js';
import { OBYTE_NETWORKS } from '../src/core/networks.js';

/**
 * Read-only checks of our assumptions about the hub API, against the public
 * Obyte testnet hub through obyte.js directly.
 * Run with: OBBYX_LIVE_TESTNET=1 pnpm test
 */
describe.runIf(process.env['OBBYX_LIVE_TESTNET'] === '1')(
  'Obyte testnet hub (live, read-only)',
  () => {
    const client = new obyte.Client(OBYTE_NETWORKS.testnet.defaultHubUrl, { testnet: true });
    afterAll(() => client.close());

    it('get_joint: a stable unit hashes to its id and its MCI is ≤ last stable MCI', async () => {
      const res = await client.api.getJoint(vectors.unit.unit);
      const unit = res.joint!.unit as unknown as Record<string, unknown>;
      const { main_chain_index: mci, ...content } = unit;
      expect(getUnitHash(content)).toBe(vectors.unit.unit);
      const lastStable = await client.api.getLastStableUnitProps();
      // The hub returns {unit, main_chain_index, timestamp} — no ball (ADR-0002).
      expect(Object.keys(lastStable).sort()).toEqual(['main_chain_index', 'timestamp', 'unit']);
      expect(mci).toBeLessThanOrEqual(lastStable.main_chain_index);
    }, 30_000);

    it('get_joint: an unknown unit answers joint_not_found as a success response', async () => {
      const res = await client.api.getJoint('A'.repeat(43) + '=');
      expect(res.joint_not_found).toBeDefined();
    }, 30_000);

    it('light/get_definition + light/get_aa_state_vars of a real channel', async () => {
      const def = await client.api.getDefinition(vectors.channel.address);
      expect(parseChannelDefinition(vectors.channel.address, def).ok).toBe(true);
      const vars = (await client.api.getAaStateVars({
        address: vectors.channel.address,
      })) as Record<string, unknown>;
      expect(typeof vars['period']).toBe('number');
    }, 30_000);
  },
);
