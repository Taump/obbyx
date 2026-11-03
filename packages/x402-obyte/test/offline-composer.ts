import obyte from 'obyte';
import { HASH_A, HASH_B, HASH_C } from '../../obyte/test/helpers.js';

/**
 * An obyte.js client that composes and signs units offline (never connects):
 * fixed parents/last ball (HASH_B/HASH_C), one 1 000 000-byte input
 * (HASH_A:0:1) owned by `payer`. Pair with FakeHub for the facilitator side.
 */
export function offlineComposer(payer: string): obyte.Client {
  const client = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  client.close();
  const c = client as unknown as {
    cachedWitnesses: string[];
    api: Record<string, (p: unknown) => Promise<unknown>>;
  };
  c.cachedWitnesses = ['W'.repeat(32)];
  c.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
    parent_units: [HASH_B],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1000,
    timestamp: Math.floor(Date.now() / 1000),
    tps_fee: 10,
  });
  c.api['getDefinitionForAddress'] = async () => ({ definition_chash: payer, is_stable: true });
  c.api['pickDivisibleCoinsForAmount'] = async () => ({
    inputs_with_proofs: [{ input: { unit: HASH_A, message_index: 0, output_index: 1 } }],
    total_amount: 1_000_000,
  });
  return client;
}
