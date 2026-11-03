import obyte from 'obyte';
import { hubCall } from '../hub/hub-call.js';
import { parseHistory } from '../hub/schemas.js';

/**
 * Finality of a broadcast `exact` unit (ADR-0002) and classification of the
 * hub's `post_joint` answers.
 */
/**
 * `light/get_history` requires a non-empty `addresses` list even when only
 * `requested_joints` matter. This address (chash of a constant definition
 * nobody can sign for) has no history, so the response stays small.
 */
export const HISTORY_PROBE_ADDRESS = obyte.utils.getChash160(['sig', { pubkey: 'A'.repeat(44) }]);

/** Stable + good iff the unit's ball is in the proofchain without is_nonserial (ADR-0002). */
export async function finalityOf(
  ctx: { readonly hubTimeoutMs: number; readonly historyProbeAddress?: string | undefined },
  client: obyte.Client,
  unitHash: string,
): Promise<'good' | 'final_bad' | 'pending'> {
  const res = await hubCall(
    () =>
      client.api.getWitnesses().then((witnesses) =>
        client.api.getHistory({
          witnesses,
          addresses: [ctx.historyProbeAddress ?? HISTORY_PROBE_ADDRESS],
          requested_joints: [unitHash],
        } as never),
      ),
    ctx.hubTimeoutMs,
  );
  if (res.kind !== 'ok') return 'pending';
  const ball = parseHistory(res.value)?.proofchainBalls.find((b) => b.unit === unitHash);
  if (ball === undefined) return 'pending';
  return ball.is_nonserial === true ? 'final_bad' : 'good';
}

/**
 * `post_joint` answers of ocore that do NOT mean the unit was rejected: the hub
 * is validating it, knows it unverified, or lacks its parents / hash tree (it
 * is behind). Anything else from the hub is a validation error (definite).
 */
const TRANSIENT_POST_ERRORS = [
  'already handling this unit',
  'known unverified',
  'unknown parents',
  'need hash tree',
  'timeout',
  'temporarily',
];

export function isTransientPostError(error: string): boolean {
  const e = error.toLowerCase();
  return TRANSIENT_POST_ERRORS.some((t) => e.includes(t));
}
