import { z } from 'zod';
import type { HistoryJoint } from '../coins/index.js';

/**
 * Shapes of the hub (light vendor) answers we rely on. The hub is trusted for
 * ledger reads (ADR-0001), but a malformed or unexpected answer must fail
 * closed ("ledger unavailable"), never crash or be half-read.
 */
const safeAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const paymentPayloadSchema = z
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

/** A message; payment payloads are validated (positions of messages/outputs are kept). */
const messageSchema = z
  .object({ app: z.string(), payload: z.unknown().optional() })
  .loose()
  .superRefine((m, ctx) => {
    if (m.app === 'payment' && !paymentPayloadSchema.safeParse(m.payload).success) {
      ctx.addIssue({ code: 'custom', message: 'malformed payment payload' });
    }
  });

export const ledgerUnitSchema = z
  .object({
    unit: z.string(),
    timestamp: z.number().optional(),
    main_chain_index: z.number().nullable().optional(),
    authors: z.array(z.object({ address: z.string() }).loose()).optional(),
    messages: z.array(messageSchema).default([]),
  })
  .loose();

export type LedgerUnit = HistoryJoint['unit'];

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

/** A unit from `get_joint` (undefined when malformed). */
export function parseLedgerUnit(raw: unknown): LedgerUnit | undefined {
  const parsed = ledgerUnitSchema.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as LedgerUnit) : undefined;
}

export interface ProofchainBall {
  readonly unit: string;
  readonly is_nonserial?: boolean | undefined;
}

/** `light/get_history` (undefined when malformed). */
export function parseHistory(
  raw: unknown,
): { joints: HistoryJoint[]; proofchainBalls: ProofchainBall[] } | undefined {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    joints: parsed.data.joints as unknown as HistoryJoint[],
    proofchainBalls: parsed.data.proofchain_balls,
  };
}

/** `light/get_aa_state_vars`: a plain record (undefined when malformed). */
export function parseStateVars(raw: unknown): Record<string, unknown> | undefined {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
