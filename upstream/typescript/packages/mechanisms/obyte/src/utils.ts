import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import obyte from "obyte";
import {
  BYTES_ASSET,
  type ObyteNetwork,
  OBYTE_TESTNET,
  SUPPORTED_OBYTE_NETWORKS,
} from "./constants";
import type { Check } from "./types";

const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const DISPLAY_RE = /^(0|[1-9][0-9]*)(\.([0-9]+))?$/;
const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;
const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Whether a value is a supported Obyte CAIP-2 network identifier.
 *
 * @param network - Candidate identifier.
 * @returns True for `obyte:livenet` and `obyte:testnet`.
 */
export function isObyteNetwork(network: unknown): network is ObyteNetwork {
  return (SUPPORTED_OBYTE_NETWORKS as readonly unknown[]).includes(network);
}

/**
 * Whether a network is the test network (obyte.js `testnet` option).
 *
 * @param network - Obyte network identifier.
 * @returns True for `obyte:testnet`.
 */
export function isTestnet(network: ObyteNetwork): boolean {
  return network === OBYTE_TESTNET;
}

/**
 * Whether a value is a valid Obyte address (32-character base32 with checksum).
 *
 * @param value - Candidate address.
 * @returns True when the checksum is valid.
 */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && obyte.utils.isValidAddress(value);
}

/**
 * Whether a value is a base64 hash (unit hash, asset id).
 *
 * @param value - Candidate hash.
 * @returns True for 44-character base64 strings ending in "=".
 */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

/**
 * Whether a value is `base` or an asset id.
 *
 * @param value - Candidate asset.
 * @returns True for `base` or a 44-character base64 asset id.
 */
export function isAssetId(value: unknown): value is string {
  return value === BYTES_ASSET || isHash(value);
}

/**
 * Parses an atomic amount in canonical decimal-string form.
 *
 * @param input - Decimal string without sign or leading zeros.
 * @returns The amount, or undefined when malformed or above 2^53 - 1.
 */
export function parseAtomicAmount(input: unknown): bigint | undefined {
  if (typeof input !== "string" || !AMOUNT_RE.test(input)) return undefined;
  const value = BigInt(input);
  return value <= MAX_AMOUNT ? value : undefined;
}

/**
 * Converts a display amount ("0.25") to atomic units without floating point.
 *
 * @param input - Display amount.
 * @param decimals - Decimals of the asset.
 * @returns The atomic amount, or undefined when malformed, too precise or too large.
 */
export function displayToAtomic(input: string, decimals: number): bigint | undefined {
  const match = DISPLAY_RE.exec(input);
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  if (fraction.length > decimals) return undefined;
  const value = BigInt((match[1] ?? "0") + fraction.padEnd(decimals, "0"));
  return value <= MAX_AMOUNT ? value : undefined;
}

/**
 * Whether a value is a non-null, non-array object.
 *
 * @param value - Candidate.
 * @returns True for plain objects.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an object has no keys outside an allowlist.
 *
 * @param obj - Object to check.
 * @param allowed - Allowed keys.
 * @returns True when every key is allowed.
 */
export function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every(k => allowed.has(k));
}

/**
 * JSON with object keys sorted recursively (stable across implementations).
 *
 * @param value - JSON value.
 * @returns Canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isPlainObject(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/**
 * SHA-256 of a string or bytes, lowercase hex.
 *
 * @param data - Input.
 * @returns Hex digest.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

/**
 * HMAC-SHA256, lowercase hex.
 *
 * @param key - Secret key.
 * @param data - Message.
 * @returns Hex MAC.
 */
export function hmacSha256Hex(key: string | Uint8Array, data: string): string {
  const k = typeof key === "string" ? utf8ToBytes(key) : key;
  return bytesToHex(hmac(sha256, k, utf8ToBytes(data)));
}

/**
 * Compares two strings in time independent of where they differ.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns True when equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A random URL-safe identifier (128 bits).
 *
 * @returns Base64url string of 22 characters.
 */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A failed check.
 *
 * @param reason - Stable reason code.
 * @param message - Human-readable explanation.
 * @returns The failure.
 */
export function fail(
  reason: string,
  message: string,
): { ok: false; reason: string; message: string } {
  return { ok: false, reason, message };
}

/**
 * A successful check.
 *
 * @param value - The checked value.
 * @returns The success.
 */
export function pass<T>(value: T): Check<T> {
  return { ok: true, value };
}

/** Outcome of one hub request; `unknown` means it may or may not have taken effect. */
export type HubOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "hub_error"; readonly error: string }
  | { readonly kind: "unknown"; readonly error: string };

/**
 * Runs one hub request with a timeout and classifies the outcome. obyte.js
 * rejects with the hub's error value (a string) for definite errors and with
 * an `Error` for transport failures; a timeout or transport failure is an
 * unknown outcome (for `post_joint` the unit may have been accepted).
 *
 * @param request - The request.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns The classified outcome.
 */
export async function hubCall<T>(
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<HubOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      request(),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error(`hub request timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { kind: "ok", value };
  } catch (err) {
    if (err instanceof Error || err === null || err === undefined) {
      return { kind: "unknown", error: err instanceof Error ? err.message : "no error value" };
    }
    return { kind: "hub_error", error: typeof err === "string" ? err : safeJson(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON of a value that may not be serializable.
 *
 * @param value - Value.
 * @returns JSON text or String(value).
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
