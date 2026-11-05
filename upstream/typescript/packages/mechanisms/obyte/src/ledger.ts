import obyte from "obyte";
import { z } from "zod";
import { ERR_INPUTS, ERR_LEDGER_UNAVAILABLE, ERR_STALE } from "./constants";
import type { ObyteHub } from "./signer";
import type { Check, ExactUnitFacts } from "./types";
import { fail, hubCall, pass } from "./utils";

/**
 * `light/get_history` needs a non-empty `addresses` list even when only
 * `requested_joints` matter. This address (of a definition nobody can sign
 * for) has no history, so the answer stays small.
 */
export const HISTORY_PROBE_ADDRESS = obyte.utils.getChash160(["sig", { pubkey: "A".repeat(44) }]);

const safeAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const paymentPayloadSchema = z
  .object({
    asset: z.string().optional(),
    inputs: z
      .array(
        z
          .object({
            unit: z.string().optional(),
            message_index: z.number().int().optional(),
            output_index: z.number().int().optional(),
          })
          .loose(),
      )
      .optional(),
    outputs: z.array(z.object({ address: z.string(), amount: safeAmount }).loose()).optional(),
  })
  .loose();

const messageSchema = z
  .object({ app: z.string(), payload: z.unknown().optional() })
  .loose()
  .superRefine((m, ctx) => {
    if (m.app === "payment" && !paymentPayloadSchema.safeParse(m.payload).success) {
      ctx.addIssue({ code: "custom", message: "malformed payment payload" });
    }
  });

const ledgerUnitSchema = z
  .object({
    unit: z.string(),
    timestamp: z.number().optional(),
    main_chain_index: z.number().nullable().optional(),
    authors: z.array(z.object({ address: z.string() }).loose()).optional(),
    messages: z.array(messageSchema).default([]),
  })
  .loose();

const historySchema = z
  .object({
    joints: z
      .array(z.object({ unit: ledgerUnitSchema, ball: z.string().optional() }).loose())
      .default([]),
    proofchain_balls: z
      .array(z.object({ unit: z.string(), is_nonserial: z.boolean().optional() }).loose())
      .default([]),
  })
  .loose();

/** A unit as read from the hub (only the fields the checks use). */
export interface LedgerUnit {
  unit: string;
  timestamp?: number;
  main_chain_index?: number | null;
  authors?: { address: string }[];
  messages?: {
    app: string;
    payload?: {
      asset?: string;
      inputs?: { unit?: string; message_index?: number; output_index?: number }[];
      outputs?: { address: string; amount: number }[];
    };
  }[];
}

/** Settings of the ledger checks. */
export interface LedgerCheckContext {
  readonly hubTimeoutMs: number;
  readonly maxLastBallAgeSeconds: number;
  readonly now: () => number;
}

/**
 * Parses a unit from `get_joint`; a malformed hub answer fails closed.
 *
 * @param raw - Hub answer.
 * @returns The unit, or undefined when malformed.
 */
export function parseLedgerUnit(raw: unknown): LedgerUnit | undefined {
  const parsed = ledgerUnitSchema.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as LedgerUnit) : undefined;
}

/**
 * Parses a `light/get_history` answer; a malformed hub answer fails closed.
 *
 * @param raw - Hub answer.
 * @returns Joints and proofchain balls, or undefined when malformed.
 */
export function parseHistory(
  raw: unknown,
):
  | { joints: { unit: LedgerUnit }[]; proofchainBalls: { unit: string; is_nonserial?: boolean }[] }
  | undefined {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    joints: parsed.data.joints as unknown as { unit: LedgerUnit }[],
    proofchainBalls: parsed.data.proofchain_balls,
  };
}

/**
 * Ledger checks (the hub is trusted for reads): the last ball is recent, every
 * input exists and belongs to the payer in its asset, inputs balance outputs
 * plus fees, and no other unit of the payer spends the same inputs.
 *
 * @param ctx - Settings.
 * @param hub - Hub of the payment's network.
 * @param facts - Facts of the locally valid unit.
 * @param unit - The unit itself (for its fees).
 * @returns Success, or the first failed check.
 */
export async function checkLedger(
  ctx: LedgerCheckContext,
  hub: ObyteHub,
  facts: ExactUnitFacts,
  unit: Record<string, unknown>,
): Promise<Check<null>> {
  const t = ctx.hubTimeoutMs;
  const lastBall = await hubCall(() => hub.getJoint(facts.lastBallUnit), t);
  if (lastBall.kind !== "ok") return fail(ERR_LEDGER_UNAVAILABLE, `last ball: ${lastBall.error}`);
  const lastBallTs = lastBall.value.joint?.unit["timestamp"];
  if (typeof lastBallTs !== "number") return fail(ERR_STALE, "Unknown last ball unit");
  const lastBallAge = ctx.now() - lastBallTs;
  if (lastBallAge > ctx.maxLastBallAgeSeconds) {
    return fail(
      ERR_STALE,
      `Last ball is ${lastBallAge} s old; the limit is ${ctx.maxLastBallAgeSeconds} s`,
    );
  }

  const totals = new Map<string, bigint>();
  const sources = new Map<string, LedgerUnit>();
  for (const input of facts.inputs) {
    let source = sources.get(input.unit);
    if (source === undefined) {
      const res = await hubCall(() => hub.getJoint(input.unit), t);
      if (res.kind !== "ok") return fail(ERR_LEDGER_UNAVAILABLE, `input source: ${res.error}`);
      if (res.value.joint === undefined) return fail(ERR_INPUTS, "Input source unit not found");
      const parsed = parseLedgerUnit(res.value.joint.unit);
      if (parsed === undefined) {
        return fail(ERR_LEDGER_UNAVAILABLE, "input source: malformed hub answer");
      }
      source = parsed;
      sources.set(input.unit, source);
    }
    const message = source.messages?.[input.messageIndex];
    const output = message?.payload?.outputs?.[input.outputIndex];
    const asset = message?.payload?.asset ?? "base";
    if (message?.app !== "payment" || output === undefined) {
      return fail(ERR_INPUTS, "Input refers to a missing output");
    }
    if (output.address !== facts.payer || asset !== input.asset) {
      return fail(ERR_INPUTS, "Input output does not belong to the payer in this asset");
    }
    totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(output.amount));
  }
  const fees =
    BigInt(facts.commissions.headers + facts.commissions.payload) +
    BigInt((unit["tps_fee"] as number | undefined) ?? 0) +
    BigInt((unit["burn_fee"] as number | undefined) ?? 0);
  for (const [asset, outTotal] of Object.entries(facts.outputTotals)) {
    const expected = asset === "base" ? outTotal + fees : outTotal;
    if (totals.get(asset) !== expected) {
      return fail(ERR_INPUTS, `Inputs and outputs do not balance in ${asset}`);
    }
  }

  // Unspent: best effort until stability; the network decides double spends.
  const history = await hubCall(
    () =>
      hub.getWitnesses().then(witnesses => hub.getHistory({ witnesses, addresses: [facts.payer] })),
    t,
  );
  if (history.kind !== "ok") return fail(ERR_LEDGER_UNAVAILABLE, `history: ${history.error}`);
  const parsedHistory = parseHistory(history.value);
  if (parsedHistory === undefined) {
    return fail(ERR_LEDGER_UNAVAILABLE, "history: malformed hub answer");
  }
  const wanted = new Set(facts.inputs.map(i => `${i.unit}:${i.messageIndex}:${i.outputIndex}`));
  for (const joint of parsedHistory.joints) {
    if (joint.unit.unit === facts.unitHash) continue;
    for (const m of joint.unit.messages ?? []) {
      if (m.app !== "payment") continue;
      for (const inp of m.payload?.inputs ?? []) {
        if (wanted.has(`${inp.unit}:${inp.message_index}:${inp.output_index}`)) {
          return fail(ERR_INPUTS, "An input is already spent by another unit");
        }
      }
    }
  }
  return pass(null);
}

/**
 * Finality of a broadcast unit: stable and good iff its ball is in the
 * proofchain without `is_nonserial`.
 *
 * @param hub - Hub of the network.
 * @param unitHash - The unit.
 * @param opts - Settings.
 * @param opts.hubTimeoutMs - Hub request timeout.
 * @param opts.historyProbeAddress - Address with no history for the request.
 * @returns `good`, `final_bad`, or `pending` (not stable yet or unknown).
 */
export async function finalityOf(
  hub: ObyteHub,
  unitHash: string,
  opts: { hubTimeoutMs: number; historyProbeAddress?: string },
): Promise<"good" | "final_bad" | "pending"> {
  const res = await hubCall(
    () =>
      hub.getWitnesses().then(witnesses =>
        hub.getHistory({
          witnesses,
          addresses: [opts.historyProbeAddress ?? HISTORY_PROBE_ADDRESS],
          requested_joints: [unitHash],
        }),
      ),
    opts.hubTimeoutMs,
  );
  if (res.kind !== "ok") return "pending";
  const ball = parseHistory(res.value)?.proofchainBalls.find(b => b.unit === unitHash);
  if (ball === undefined) return "pending";
  return ball.is_nonserial === true ? "final_bad" : "good";
}

/**
 * `post_joint` answers that do not mean the unit was rejected: the hub is
 * validating it, knows it unverified, or lacks its parents / hash tree.
 */
const TRANSIENT_POST_ERRORS = [
  "already handling this unit",
  "known unverified",
  "unknown parents",
  "need hash tree",
  "timeout",
  "temporarily",
];

/**
 * Whether a `post_joint` error is transient (not a rejection of the unit).
 *
 * @param error - Hub error text.
 * @returns True for transient answers.
 */
export function isTransientPostError(error: string): boolean {
  const e = error.toLowerCase();
  return TRANSIENT_POST_ERRORS.some(t => e.includes(t));
}
