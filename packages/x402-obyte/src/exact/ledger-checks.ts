import type obyte from 'obyte';
import type { ExactUnitFacts } from '@obbyx/obyte';
import { hubCall } from '../hub/hub-call.js';
import { type LedgerUnit, parseHistory, parseLedgerUnit } from '../hub/schemas.js';
import { type Check, EXACT_SETTLE_REASONS, fail } from './reasons.js';
import type { ParsedExactRequirements } from './requirements.js';

export interface LedgerCheckContext {
  readonly hubTimeoutMs: number;
  readonly maxLastBallAgeSeconds: number;
  readonly now: () => number;
}

/**
 * Ledger checks (hub-trusted, ADR-0001/0002): last ball recency, inputs
 * exist and belong to the payer, amounts + fees balance, inputs unspent.
 */
export async function checkLedger(
  ctx: LedgerCheckContext,
  client: obyte.Client,
  req: ParsedExactRequirements,
  facts: ExactUnitFacts,
  unit: Record<string, unknown>,
): Promise<Check<null>> {
  const t = ctx.hubTimeoutMs;
  const lastBall = await hubCall(() => client.api.getJoint(facts.lastBallUnit), t);
  if (lastBall.kind !== 'ok')
    return fail(EXACT_SETTLE_REASONS.ledger, `last ball: ${lastBall.error}`);
  const lastBallTs = lastBall.value.joint?.unit.timestamp;
  if (typeof lastBallTs !== 'number')
    return fail(EXACT_SETTLE_REASONS.stale, 'Unknown last ball unit');
  const lastBallAge = ctx.now() - lastBallTs;
  if (lastBallAge > ctx.maxLastBallAgeSeconds) {
    return fail(
      EXACT_SETTLE_REASONS.stale,
      `Last ball is ${lastBallAge} s old; the limit is ${ctx.maxLastBallAgeSeconds} s (MAX_LAST_BALL_AGE_SECONDS)`,
    );
  }

  // Inputs: each referenced output exists, belongs to the payer, has the right asset.
  const totals = new Map<string, bigint>();
  const sources = new Map<string, LedgerUnit>();
  for (const input of facts.inputs) {
    let source = sources.get(input.unit);
    if (source === undefined) {
      const res = await hubCall(() => client.api.getJoint(input.unit), t);
      if (res.kind !== 'ok') return fail(EXACT_SETTLE_REASONS.ledger, `input source: ${res.error}`);
      if (res.value.joint === undefined)
        return fail(EXACT_SETTLE_REASONS.inputs, 'Input source unit not found');
      const parsedSource = parseLedgerUnit(res.value.joint.unit);
      if (parsedSource === undefined)
        return fail(EXACT_SETTLE_REASONS.ledger, 'input source: malformed hub answer');
      source = parsedSource;
      sources.set(input.unit, source);
    }
    const message = source.messages?.[input.messageIndex];
    const output = message?.payload?.outputs?.[input.outputIndex];
    const asset = message?.payload?.asset ?? 'base';
    if (message?.app !== 'payment' || output === undefined) {
      return fail(EXACT_SETTLE_REASONS.inputs, 'Input refers to a missing output');
    }
    if (
      output.address !== facts.payer ||
      asset !== input.asset ||
      !Number.isSafeInteger(output.amount)
    ) {
      return fail(
        EXACT_SETTLE_REASONS.inputs,
        'Input output does not belong to the payer in this asset',
      );
    }
    totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(output.amount));
  }
  const fees =
    BigInt(facts.commissions.headers + facts.commissions.payload) +
    BigInt((unit['tps_fee'] as number | undefined) ?? 0) +
    BigInt((unit['burn_fee'] as number | undefined) ?? 0);
  for (const [asset, outTotal] of Object.entries(facts.outputTotals)) {
    const expected = asset === 'base' ? outTotal + fees : outTotal;
    if (totals.get(asset) !== expected) {
      return fail(EXACT_SETTLE_REASONS.inputs, `Inputs and outputs do not balance in ${asset}`);
    }
  }

  // Unspent: no other unit of the payer spends these inputs (best effort
  // until stability; the network decides double-spends definitively).
  const history = await hubCall(
    () =>
      client.api
        .getWitnesses()
        .then((witnesses) =>
          client.api.getHistory({ witnesses, addresses: [facts.payer] } as never),
        ),
    t,
  );
  if (history.kind !== 'ok') return fail(EXACT_SETTLE_REASONS.ledger, `history: ${history.error}`);
  const parsedHistory = parseHistory(history.value);
  if (parsedHistory === undefined)
    return fail(EXACT_SETTLE_REASONS.ledger, 'history: malformed hub answer');
  const wanted = new Set(facts.inputs.map((i) => `${i.unit}:${i.messageIndex}:${i.outputIndex}`));
  for (const joint of parsedHistory.joints) {
    if (joint.unit.unit === facts.unitHash) continue;
    for (const m of joint.unit.messages ?? []) {
      if (m.app !== 'payment') continue;
      for (const inp of m.payload?.inputs ?? []) {
        if (wanted.has(`${inp.unit}:${inp.message_index}:${inp.output_index}`)) {
          return fail(EXACT_SETTLE_REASONS.inputs, 'An input is already spent by another unit');
        }
      }
    }
  }
  return { ok: true, value: null };
}
