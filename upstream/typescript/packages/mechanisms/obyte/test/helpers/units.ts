import { createHash } from "node:crypto";
import obyte from "obyte";
import {
  getBase64Hash,
  getUnitHash,
  getUnitHashToSign,
  sign,
  toPublicKey,
} from "obyte/lib/internal.js";
import type { ClientObyteSigner } from "../../src/signer";
import { expectedCommissions } from "../../src/unit";
import type { FakeHub } from "./fakeHub";

export const HASH_A = "A".repeat(43) + "=";
export const HASH_B = "B".repeat(43) + "=";
export const HASH_C = "C".repeat(43) + "=";
/** Timestamp of every composed test unit and of the last ball HASH_C. */
export const UNIT_TS = 1_790_000_000;
export const NETWORK = "obyte:testnet" as const;
/** One input owned by the payer: HASH_A, message 0, output 1. */
export const COIN = { unit: HASH_A, messageIndex: 0, outputIndex: 1, amount: 1_000_000 };

/**
 * Deterministic throwaway private key (never funded).
 *
 * @param label - Key label.
 * @returns 32-byte key.
 */
export function testKey(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`x402-obyte-test:${label}`).digest());
}

/**
 * Definition of a test key.
 *
 * @param key - Private key.
 * @returns `['sig', {pubkey}]`.
 */
export function sigDefinitionOf(key: Uint8Array): ["sig", { pubkey: string }] {
  return ["sig", { pubkey: toPublicKey(key) }];
}

/**
 * Address of a test key.
 *
 * @param key - Private key.
 * @returns The address.
 */
export function addressOf(key: Uint8Array): string {
  return obyte.utils.getChash160(sigDefinitionOf(key));
}

/**
 * An obyte.js client that composes and signs units offline: fixed parents and
 * last ball, one 1 000 000-byte input, no connection.
 *
 * @param key - Author key.
 * @param opts - Options.
 * @param opts.includeDefinition - Embed the author definition (default true).
 * @param opts.timestamp - Unit timestamp.
 * @returns The client.
 */
export function offlineClient(
  key: Uint8Array,
  opts: { includeDefinition?: boolean; timestamp?: number } = {},
): obyte.Client {
  const client = new obyte.Client("ws://127.0.0.1:9", { testnet: true });
  client.close();
  const c = client as unknown as {
    cachedWitnesses: string[];
    api: Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
  };
  c.cachedWitnesses = ["W".repeat(32)];
  c.api["getParentsAndLastBallAndWitnessListUnit"] = async () => ({
    parent_units: [HASH_B],
    last_stable_mc_ball: HASH_B,
    last_stable_mc_ball_unit: HASH_C,
    last_stable_mc_ball_mci: 1000,
    timestamp: opts.timestamp ?? UNIT_TS,
    tps_fee: 10,
  });
  const address = addressOf(key);
  // A definition already on the ledger is not embedded again by obyte.js.
  c.api["getDefinitionForAddress"] = async () =>
    opts.includeDefinition === false
      ? { definition_chash: address, is_stable: true, definition: sigDefinitionOf(key) }
      : { definition_chash: address, is_stable: true };
  c.api["pickDivisibleCoinsForAmount"] = async () => ({
    inputs_with_proofs: [
      {
        input: {
          unit: COIN.unit,
          message_index: COIN.messageIndex,
          output_index: COIN.outputIndex,
        },
      },
    ],
    total_amount: COIN.amount,
  });
  return client;
}

/**
 * Prepares the hub for a payer: its coin and the last ball exist.
 *
 * @param hub - Fake hub.
 * @param payer - Payer address.
 */
export function fundPayer(hub: FakeHub, payer: string): void {
  hub.joints.set(HASH_A, {
    unit: HASH_A,
    messages: [
      {
        app: "payment",
        payload: {
          outputs: [
            { address: "X", amount: 1 },
            { address: payer, amount: COIN.amount },
          ],
        },
      },
    ],
  });
  hub.joints.set(HASH_C, { unit: HASH_C, timestamp: UNIT_TS - 60 });
}

/**
 * Signs `exact` units offline with a test key.
 *
 * @param key - Private key.
 * @param opts - Offline client options.
 * @param opts.includeDefinition - Embed the author definition.
 * @param opts.timestamp - Unit timestamp.
 * @returns A client signer.
 */
export function offlineSigner(
  key: Uint8Array,
  opts: { includeDefinition?: boolean; timestamp?: number } = {},
): ClientObyteSigner {
  const client = offlineClient(key, opts);
  return {
    address: addressOf(key),
    signUnit: (_network, messages) =>
      client.compose.message("multi", messages as never, {
        privateKey: key,
        testnet: true,
      }) as unknown as Promise<Record<string, unknown>>,
  };
}

/**
 * Re-finalizes a mutated unit as an attacker with the key could: recomputes
 * payload hashes and commissions, re-signs and re-hashes (each optional).
 *
 * @param unit - Unit to change.
 * @param key - Author key.
 * @param opts - What to recompute.
 * @param opts.payloadHashes - Payload hashes.
 * @param opts.commissions - Commissions.
 * @param opts.sign - Signature.
 * @param opts.unitHash - Unit hash.
 * @returns The new unit.
 */
export function refinalize(
  unit: Record<string, unknown>,
  key: Uint8Array,
  opts: { payloadHashes?: boolean; commissions?: boolean; sign?: boolean; unitHash?: boolean } = {},
): Record<string, unknown> {
  const { payloadHashes = true, commissions = true, sign: doSign = true, unitHash = true } = opts;
  const u = structuredClone(unit);
  const messages = u["messages"] as { payload: unknown; payload_hash: string }[];
  if (payloadHashes) for (const m of messages) m.payload_hash = getBase64Hash(m.payload, true);
  if (commissions) {
    const c = expectedCommissions(u);
    u["headers_commission"] = c.headers;
    u["payload_commission"] = c.payload;
  }
  const author = (u["authors"] as Record<string, unknown>[])[0]!;
  if (doSign) author["authentifiers"] = { r: sign(getUnitHashToSign(u), key) };
  if (unitHash) u["unit"] = getUnitHash(u);
  return u;
}
