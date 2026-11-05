import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ERR_INVALID_NETWORK,
  ERR_INVALID_REQUIREMENTS,
  ERR_UNSUPPORTED_SCHEME,
  type ObyteNetwork,
  SCHEME_EXACT,
} from "../constants";
import { type Check, type ExactObyteExtra, exactObyteExtraSchema } from "../types";
import {
  canonicalJson,
  fail,
  isAddress,
  isAssetId,
  isHash,
  isObyteNetwork,
  parseAtomicAmount,
  pass,
} from "../utils";

/** Requirements of `exact` on Obyte after validation. */
export interface ParsedExactRequirements {
  readonly network: ObyteNetwork;
  readonly asset: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: ExactObyteExtra;
}

/**
 * Validates `exact` requirements for Obyte.
 *
 * @param req - Payment requirements.
 * @returns The parsed requirements, or the reason they are invalid.
 */
export function parseExactRequirements(req: PaymentRequirements): Check<ParsedExactRequirements> {
  if (req.scheme !== SCHEME_EXACT) return fail(ERR_UNSUPPORTED_SCHEME, "Scheme is not exact");
  if (!isObyteNetwork(req.network)) return fail(ERR_INVALID_NETWORK, "Not an Obyte network");
  if (!isAssetId(req.asset)) return fail(ERR_INVALID_REQUIREMENTS, "Invalid asset");
  if (!isAddress(req.payTo)) return fail(ERR_INVALID_REQUIREMENTS, "Invalid payTo");
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
    return fail(ERR_INVALID_REQUIREMENTS, "Invalid maxTimeoutSeconds");
  }
  const amount = parseAtomicAmount(req.amount);
  if (amount === undefined) return fail(ERR_INVALID_REQUIREMENTS, "Invalid amount");
  if (amount <= 0n) return fail(ERR_INVALID_REQUIREMENTS, "Amount must be positive");
  const extra = exactObyteExtraSchema.safeParse(req.extra);
  if (!extra.success) {
    return fail(ERR_INVALID_REQUIREMENTS, `Invalid extra: ${extra.error.issues[0]?.message}`);
  }
  return pass({
    network: req.network,
    asset: req.asset,
    amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: extra.data,
  });
}

/**
 * Whether the requirements the client accepted are the server's (x402 core
 * does not compare them; a mismatch could pay under different terms).
 *
 * @param payload - Payment payload.
 * @param req - The server's requirements.
 * @returns True when identical.
 */
export function acceptedMatches(payload: PaymentPayload, req: PaymentRequirements): boolean {
  const a = payload.accepted;
  return (
    a !== undefined &&
    a.scheme === req.scheme &&
    a.network === req.network &&
    a.asset === req.asset &&
    a.amount === req.amount &&
    a.payTo === req.payTo &&
    a.maxTimeoutSeconds === req.maxTimeoutSeconds &&
    canonicalJson(a.extra) === canonicalJson(req.extra)
  );
}

/**
 * The unit hash of an `exact` payload.
 *
 * @param payload - Payment payload.
 * @returns The unit hash, or undefined when missing or malformed.
 */
export function unitHashOf(payload: { payload?: Record<string, unknown> }): string | undefined {
  const unit = payload.payload?.["unit"];
  const hash = unit && typeof unit === "object" ? (unit as { unit?: unknown }).unit : undefined;
  return isHash(hash) ? hash : undefined;
}

/**
 * Key of a payment unit in the facilitator's and the server's stores.
 *
 * @param network - Network identifier.
 * @param unitHash - Unit hash.
 * @returns `<network>:unit:<hash>` (a unit is unique per network).
 */
export function unitKey(network: string, unitHash: string): string {
  return `${network}:unit:${unitHash}`;
}
