import obyte from "obyte";
import { toPublicKey } from "obyte/lib/internal.js";
import type { ObyteNetwork } from "./constants";
import type { ObyteUnit } from "./types";
import { isTestnet } from "./utils";

/**
 * The hub requests the facilitator needs, shaped like obyte.js `client.api`.
 * Any object with these methods works (a light vendor hub, a test double).
 */
export interface ObyteHub {
  getJoint(
    unit: string,
  ): Promise<{ joint?: { unit: Record<string, unknown> } } & Record<string, unknown>>;
  getDefinition(address: string): Promise<unknown>;
  getWitnesses(): Promise<string[]>;
  getHistory(params: {
    witnesses: string[];
    addresses: string[];
    requested_joints?: string[];
  }): Promise<unknown>;
  postJoint(joint: { unit: ObyteUnit }): Promise<unknown>;
}

/**
 * Signs payment units for the client. The unit is composed against the hub
 * (parents, last ball, coins) and signed, but never broadcast: the
 * facilitator publishes it.
 */
export interface ClientObyteSigner {
  /** The payer address. */
  readonly address: string;
  /**
   * Composes and signs one unit with the given messages.
   *
   * @param network - Network of the payment.
   * @param messages - `payment` and `data` messages (payloads only).
   * @returns The signed unit.
   */
  signUnit(
    network: ObyteNetwork,
    messages: { app: string; payload: unknown }[],
  ): Promise<ObyteUnit>;
}

/**
 * Hub access of an obyte.js client for the facilitator.
 *
 * @param client - obyte.js client connected to a hub of the network.
 * @returns The hub interface.
 */
export function toObyteHub(client: obyte.Client): ObyteHub {
  return client.api as unknown as ObyteHub;
}

/**
 * Address of a single-signature wallet.
 *
 * @param privateKey - 32-byte secp256k1 private key.
 * @returns The Obyte address of `['sig', {pubkey}]`.
 */
export function addressOfPrivateKey(privateKey: Uint8Array): string {
  return obyte.utils.getChash160(["sig", { pubkey: toPublicKey(privateKey) }]);
}

/**
 * A client signer over an obyte.js client and a private key. Units are
 * composed one at a time.
 *
 * Coins: until the facilitator publishes a signed unit the hub does not know
 * its inputs are spent, so the next unit may pick the same coins (one of the
 * two then fails as a double spend; the client never pays twice). A wallet
 * that pays concurrently should install its own coin picker on
 * `client.api.pickDivisibleCoinsForAmount` that skips coins of unpublished
 * units.
 *
 * @param client - obyte.js client connected to a hub of the network.
 * @param privateKey - 32-byte secp256k1 private key of a single-sig wallet.
 * @returns The signer.
 */
export function toClientObyteSigner(
  client: obyte.Client,
  privateKey: Uint8Array,
): ClientObyteSigner {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    address: addressOfPrivateKey(privateKey),
    signUnit(network, messages) {
      const run = queue.then(
        () =>
          client.compose.message("multi", messages as never, {
            privateKey,
            testnet: isTestnet(network),
          }) as unknown as Promise<ObyteUnit>,
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Parses a 32-byte private key given as 64 hex characters or base64.
 *
 * @param text - Encoded key.
 * @returns The key bytes.
 */
export function parseObytePrivateKey(text: string): Uint8Array {
  const trimmed = text.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Uint8Array.from(trimmed.match(/../g)!.map(h => parseInt(h, 16)))
    : Uint8Array.from(atob(trimmed), c => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("An Obyte private key has 32 bytes (hex or base64)");
  return bytes;
}

/**
 * Connects an obyte.js client to a hub (light vendor).
 *
 * @param hubUrl - WebSocket URL, e.g. `wss://obyte.org/bb-test`.
 * @param network - Network of the hub.
 * @returns The connected client (close it with `client.close()`).
 */
export function connectObyteHub(hubUrl: string, network: ObyteNetwork): obyte.Client {
  return new obyte.Client(hubUrl, { testnet: isTestnet(network), reconnect: true });
}
