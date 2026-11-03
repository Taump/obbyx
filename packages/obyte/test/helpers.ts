import { createHash } from 'node:crypto';
import obyte from 'obyte';
import {
  getBase64Hash,
  getUnitHash,
  getUnitHashToSign,
  sign,
  toPublicKey,
} from 'obyte/lib/internal.js';
import { expectedCommissions } from '../src/unit/exact-unit.js';

/** Deterministic throwaway private key for tests (never funded). */
export function testKey(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`obbyx-test:${label}`).digest());
}

export function addressOf(key: Uint8Array): string {
  return obyte.utils.getChash160(sigDefinitionOf(key) as unknown as unknown[]);
}

export function sigDefinitionOf(key: Uint8Array): ['sig', { pubkey: string }] {
  return ['sig', { pubkey: toPublicKey(key) }];
}

export const HASH_A = 'A'.repeat(43) + '=';
export const HASH_B = 'B'.repeat(43) + '=';
export const HASH_C = 'C'.repeat(43) + '=';

export interface Coin {
  unit: string;
  messageIndex: number;
  outputIndex: number;
  amount: number;
}

/**
 * Composes and signs a unit with obyte.js `client.compose.message` OFFLINE:
 * the hub calls compose needs are replaced by fixed ledger props and an
 * explicit coin picker — the same technique the client SDK uses to reserve
 * inputs (ADR-0002).
 */
export async function composeTestUnit(options: {
  key: Uint8Array;
  messages: { app: string; payload: unknown }[];
  coins: Partial<Record<string, Coin[]>>;
  includeDefinition?: boolean;
  tpsFee?: number;
}): Promise<Record<string, unknown>> {
  const client = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
  client.close();
  const address = addressOf(options.key);
  const c = client as unknown as {
    cachedWitnesses: string[];
    api: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
  };
  c.cachedWitnesses = ['W'.repeat(32)];
  c.api['getParentsAndLastBallAndWitnessListUnit'] = async () => ({
    parent_units: [HASH_A],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1000,
    timestamp: 1_790_000_000,
    tps_fee: options.tpsFee ?? 10,
  });
  c.api['getDefinitionForAddress'] = async () =>
    options.includeDefinition === false
      ? { definition_chash: address, definition: sigDefinitionOf(options.key), is_stable: true }
      : { definition_chash: address, is_stable: true };
  c.api['pickDivisibleCoinsForAmount'] = async (params) => {
    const coins = options.coins[(params['asset'] as string | undefined) ?? 'base'] ?? [];
    return {
      inputs_with_proofs: coins.map((coin) => ({
        input: {
          unit: coin.unit,
          message_index: coin.messageIndex,
          output_index: coin.outputIndex,
        },
      })),
      total_amount: coins.reduce((s, coin) => s + coin.amount, 0),
    };
  };
  const unit = await client.compose.message('multi', options.messages, {
    privateKey: options.key,
    testnet: true,
  });
  return unit as unknown as Record<string, unknown>;
}

/**
 * Re-finalizes a (mutated) unit the way an attacker with the key could:
 * optionally recomputes payload hashes and commissions, then re-signs and
 * re-hashes. Used to test that each check holds on its own.
 */
export function refinalize(
  unit: Record<string, unknown>,
  key: Uint8Array,
  opts: { payloadHashes?: boolean; commissions?: boolean; sign?: boolean; unitHash?: boolean } = {},
): Record<string, unknown> {
  const { payloadHashes = true, commissions = true, sign: doSign = true, unitHash = true } = opts;
  const u = structuredClone(unit);
  const messages = u['messages'] as { payload: unknown; payload_hash: string }[];
  if (payloadHashes) {
    for (const m of messages) m.payload_hash = getBase64Hash(m.payload, true);
  }
  if (commissions) {
    const c = expectedCommissions(u);
    u['headers_commission'] = c.headers;
    u['payload_commission'] = c.payload;
  }
  const author = (u['authors'] as Record<string, unknown>[])[0]!;
  if (doSign) author['authentifiers'] = { r: sign(getUnitHashToSign(u), key) };
  if (unitHash) u['unit'] = getUnitHash(u);
  return u;
}
