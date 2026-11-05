import { z } from "zod";

/**
 * Scheme-specific `extra` of `exact` PaymentRequirements on Obyte.
 *
 * `binding` is an HMAC the resource server computes per request over the offer
 * and the request; the client signs it into the unit's data message.
 * `quoteId` and `validUntil` identify and bound the offer.
 */
export const exactObyteExtraSchema = z
  .object({
    binding: z.string().regex(/^[0-9a-f]{64}$/, "binding must be 64 lowercase hex chars"),
    quoteId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    validUntil: z.number().int().positive(),
    // x402 §6.1: `authorization` (default) and `upfront` flows only; Obyte has
    // no asset transfer method (the payer signs the transfer itself).
    paymentFlow: z.enum(["authorization", "upfront"]).optional(),
  })
  .strict();

/** Parsed `extra` of `exact` requirements. */
export type ExactObyteExtra = z.infer<typeof exactObyteExtraSchema>;

/** `PaymentPayload.payload` of `exact` on Obyte: the signed, not broadcast unit. */
export interface ExactObytePayload {
  [key: string]: unknown;
  unit: ObyteUnit;
}

/** An Obyte unit as JSON (validated by the facilitator, never trusted). */
export type ObyteUnit = Record<string, unknown>;

/** An author definition of the supported profile: a single signature. */
export type SigDefinition = readonly ["sig", { readonly pubkey: string }];

/** Result of a check: a value, or a stable reason code with a message. */
export type Check<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/** One input of a payment unit. */
export interface InputRef {
  readonly asset: string;
  readonly unit: string;
  readonly messageIndex: number;
  readonly outputIndex: number;
}

/** Facts of a locally valid unit that the ledger checks rely on. */
export interface ExactUnitFacts {
  readonly unitHash: string;
  readonly payer: string;
  readonly inputs: readonly InputRef[];
  readonly lastBallUnit: string;
  readonly parentUnits: readonly string[];
  readonly timestamp: number;
  /** Sum of outputs per asset ('base' for bytes). */
  readonly outputTotals: Readonly<Record<string, bigint>>;
  readonly commissions: { readonly headers: number; readonly payload: number };
  /** True when the author definition came from the ledger, not the unit. */
  readonly definitionFromLedger: boolean;
}
