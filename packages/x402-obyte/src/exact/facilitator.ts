import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  EXACT_REASONS,
  type ExactUnitFacts,
  OBYTE_CAIP_FAMILY,
  type SigDefinition,
  getNetwork,
  isObyteNetwork,
  isSigDefinition,
  networkKey,
  validateExactUnit,
} from '@obbyx/obyte';
import { type Logger, moduleLogger, withLogContext } from '@obbyx/obyte/logger';
import type obyte from 'obyte';

import { hubCall } from '../hub/hub-call.js';
import { finalityOf, isTransientPostError } from './finality.js';
import { checkLedger } from './ledger-checks.js';
import { type Check, EXACT_SETTLE_REASONS, fail } from './reasons.js';
import {
  EXACT_SCHEME,
  type ParsedExactRequirements,
  acceptedMatches,
  parseExactRequirements,
} from './requirements.js';
import { type SettlementRecord, type SettlementStore, TERMINAL_STATES } from './store.js';

/**
 * x402 `exact` facilitator for Obyte (ADR-0002).
 *
 * The client signs a unit paying `payTo` and carrying the seller's binding in a
 * data message; it does not broadcast. `/verify` checks it read-only (local
 * profile + ledger reads); `/settle` claims it in the store, broadcasts it and
 * reports success only when the configured finality policy is met.
 *
 * obyte.js is used directly (`client.api.*`); every hub call goes through
 * {@link hubCall} for timeouts and unknown-outcome classification (I7).
 */
export type FinalityPolicy = 'stable' | 'accepted';
export { EXACT_SETTLE_REASONS } from './reasons.js';
export { HISTORY_PROBE_ADDRESS, isTransientPostError } from './finality.js';

export interface ExactObyteFacilitatorOptions {
  /** obyte.js clients by CAIP-2 network id. */
  readonly clients: ReadonlyMap<string, obyte.Client>;
  readonly store: SettlementStore;
  readonly logger: Logger;
  /** Allowed assets per CAIP-2 network ('base' = bytes). */
  readonly allowedAssets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly finality?: FinalityPolicy;
  /** Addresses controlled by the facilitator; they may never be the payer. */
  readonly facilitatorAddresses?: readonly string[];
  readonly hubTimeoutMs?: number;
  /** Tolerated clock difference between client, hub and us (seconds). */
  readonly maxClockSkewSeconds?: number;
  /** After acceptance, how long a claimed unit may still be (re)broadcast. */
  readonly publishWindowSeconds?: number;
  /**
   * Oldest accepted `last_ball` of a payment unit, seconds (default 10800 = 3 h).
   * Independent of `maxTimeoutSeconds`: with few transactions the network's
   * stable point normally lags up to ~2 hours, while the unit's freshness is already guaranteed by the
   * offer binding (it contains a random quoteId issued at most quote-TTL ago).
   */
  readonly maxLastBallAgeSeconds?: number;
  /** Address with no history for the mandatory `addresses` of history requests. */
  readonly historyProbeAddress?: string;
  readonly now?: () => number;
}

export class ExactObyteFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = EXACT_SCHEME;
  readonly caipFamily = OBYTE_CAIP_FAMILY;

  private readonly log: Logger;
  private readonly finality: FinalityPolicy;
  private readonly hubTimeoutMs: number;
  private readonly skew: number;
  private readonly publishWindow: number;
  private readonly maxLastBallAge: number;
  private readonly now: () => number;
  /** Serializes settle/resume per settlement key inside this process. */
  private readonly inFlight = new Map<string, Promise<SettleResponse>>();

  constructor(private readonly options: ExactObyteFacilitatorOptions) {
    this.log = moduleLogger(options.logger, 'x402.exact', { scheme: EXACT_SCHEME });
    this.finality = options.finality ?? 'stable';
    this.hubTimeoutMs = options.hubTimeoutMs ?? 15_000;
    this.skew = options.maxClockSkewSeconds ?? 120;
    this.publishWindow = options.publishWindowSeconds ?? 300;
    this.maxLastBallAge = options.maxLastBallAgeSeconds ?? 10_800;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    const assets = this.options.allowedAssets.get(network);
    return { finality: this.finality, assets: assets === undefined ? [] : [...assets] };
  }

  /** The payer pays its own fees; the facilitator signs nothing in `exact`. */
  getSigners(): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return withLogContext({ scheme: EXACT_SCHEME, network: requirements.network }, async () => {
      const checked = await this.check(payload, requirements);
      if (!checked.ok) {
        this.log.info({ reason: checked.reason, detail: checked.message }, 'verify rejected');
        return { isValid: false, invalidReason: checked.reason, invalidMessage: checked.message };
      }
      const { facts } = checked.value;
      this.log.info({ proofId: facts.unitHash, payer: facts.payer }, 'verify ok');
      return { isValid: true, payer: facts.payer };
    });
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return withLogContext({ scheme: EXACT_SCHEME, network: requirements.network }, async () => {
      const network = requirements.network as Network;
      const unitHash = unitHashOf(payload);
      if (unitHash === undefined) {
        return failure(network, EXACT_SETTLE_REASONS.payload, 'Missing unit');
      }
      if (!isObyteNetwork(requirements.network)) {
        return failure(network, 'invalid_network', 'Not an Obyte network');
      }
      const existing = await this.options.store.get(this.key(requirements.network, unitHash));
      if (existing === undefined) {
        const checked = await this.check(payload, requirements);
        if (!checked.ok) {
          this.log.info(
            { proofId: unitHash, reason: checked.reason },
            'settle rejected at verification',
          );
          return failure(network, checked.reason, checked.message);
        }
        const { facts, req } = checked.value;
        const { created, record } = await this.options.store.claim({
          key: this.key(requirements.network, facts.unitHash),
          network: requirements.network,
          unitHash: facts.unitHash,
          binding: req.extra.binding,
          payer: facts.payer,
          payTo: req.payTo,
          asset: req.asset,
          amount: req.amount.toString(),
          unitJson: JSON.stringify(payload.payload['unit']),
          publishDeadline: this.now() + this.publishWindow,
        });
        this.log.info(
          { proofId: facts.unitHash, created, binding: req.extra.binding },
          'settlement claimed',
        );
        return this.drive(record);
      }
      // Idempotent resume: the same unit is bound to exactly one binding.
      const binding = (requirements.extra as { binding?: unknown }).binding;
      if (existing.binding !== binding || existing.payTo !== requirements.payTo) {
        return failure(
          network,
          'invalid_payment_reused',
          'This payment is bound to another operation',
        );
      }
      return this.drive(existing);
    });
  }

  /** Re-drives a non-terminal settlement (used by the recovery worker). */
  resume(record: SettlementRecord): Promise<SettleResponse> {
    return withLogContext(
      { scheme: EXACT_SCHEME, network: record.network, proofId: record.unitHash },
      () => this.drive(record),
    );
  }

  // --- verification ---------------------------------------------------------

  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Check<{ facts: ExactUnitFacts; req: ParsedExactRequirements }>> {
    if (payload.x402Version !== 2)
      return fail(EXACT_SETTLE_REASONS.version, 'Only x402 v2 is supported here');
    if (!acceptedMatches(payload, requirements)) {
      return fail(
        EXACT_SETTLE_REASONS.acceptedMismatch,
        'Accepted requirements differ from the server requirements',
      );
    }
    const parsed = parseExactRequirements(requirements);
    if (!parsed.ok) return fail(parsed.reason, parsed.message);
    const req = parsed.value;
    const now = this.now();
    if (req.extra.validUntil < now)
      return fail(EXACT_SETTLE_REASONS.quoteExpired, 'The payment offer has expired');
    if (!this.options.allowedAssets.get(req.network.caip2)?.has(req.asset)) {
      return fail(EXACT_REASONS.asset, 'Asset is not accepted by this facilitator');
    }
    const client = this.options.clients.get(req.network.caip2);
    if (client === undefined) return fail('invalid_network', 'Network is not served');

    const unit = payload.payload['unit'];
    const expectation = {
      network: req.network,
      payTo: req.payTo,
      asset: req.asset,
      amount: req.amount,
      binding: req.extra.binding,
      quoteId: req.extra.quoteId,
      ...(this.options.facilitatorAddresses
        ? { facilitatorAddresses: this.options.facilitatorAddresses }
        : {}),
    };
    let local = validateExactUnit(unit, expectation);
    if (!local.ok && local.reason === EXACT_REASONS.definitionRequired) {
      const definition = await this.fetchDefinition(client, unit);
      if (!definition.ok) return definition;
      local = validateExactUnit(unit, expectation, { authorDefinition: definition.value });
    }
    if (!local.ok) return fail(local.reason, local.message);
    const facts = local.value;

    // Clock sanity: the unit was composed recently.
    if (Math.abs(facts.timestamp - now) > this.skew + req.maxTimeoutSeconds) {
      return fail(EXACT_SETTLE_REASONS.stale, 'Unit timestamp is outside the acceptance window');
    }
    // payTo must be a plain address: a payment to an autonomous agent triggers
    // it, and the AA may bounce the funds back to the payer (the unit is still
    // valid and final, so the seller would serve without being paid).
    const recipient = await this.recipientIsNotAa(client, req.payTo);
    if (!recipient.ok) return recipient;
    const ledger = await checkLedger(
      {
        hubTimeoutMs: this.hubTimeoutMs,
        maxLastBallAgeSeconds: this.maxLastBallAge,
        now: this.now,
      },
      client,
      req,
      facts,
      unit as Record<string, unknown>,
    );
    if (!ledger.ok) return ledger;
    return { ok: true, value: { facts, req } };
  }

  /** Known plain (non-AA) recipients; an address can never turn into an AA. */
  private readonly plainRecipients = new Set<string>();

  private async recipientIsNotAa(client: obyte.Client, payTo: string): Promise<Check<null>> {
    if (this.plainRecipients.has(payTo)) return { ok: true, value: null };
    const res = await hubCall(() => client.api.getDefinition(payTo), this.hubTimeoutMs);
    if (res.kind !== 'ok')
      return fail(EXACT_SETTLE_REASONS.ledger, `Cannot read the payTo definition: ${res.error}`);
    const definition = res.value as unknown;
    if (Array.isArray(definition) && definition[0] === 'autonomous agent') {
      return fail(EXACT_SETTLE_REASONS.payToAa, 'payTo is an autonomous agent');
    }
    // An unused address has no definition yet (null): fine, but not cached.
    if (definition !== null && definition !== undefined) this.plainRecipients.add(payTo);
    return { ok: true, value: null };
  }

  private async fetchDefinition(
    client: obyte.Client,
    unit: unknown,
  ): Promise<Check<SigDefinition>> {
    const address = (unit as { authors?: { address?: unknown }[] }).authors?.[0]?.address;
    if (typeof address !== 'string') return fail(EXACT_REASONS.unsupported, 'Malformed author');
    const res = await hubCall(() => client.api.getDefinition(address), this.hubTimeoutMs);
    if (res.kind !== 'ok')
      return fail(EXACT_SETTLE_REASONS.ledger, `Cannot read definition: ${res.error}`);
    if (!isSigDefinition(res.value)) {
      return fail(
        EXACT_REASONS.definition,
        'Payer definition is unknown or not a single-sig definition',
      );
    }
    return { ok: true, value: res.value };
  }

  // --- settlement state machine --------------------------------------------------

  private drive(record: SettlementRecord): Promise<SettleResponse> {
    const running = this.inFlight.get(record.key);
    if (running !== undefined) return running;
    const promise = this.step(record).finally(() => this.inFlight.delete(record.key));
    this.inFlight.set(record.key, promise);
    return promise;
  }

  private async step(initial: SettlementRecord): Promise<SettleResponse> {
    const store = this.options.store;
    const client = this.options.clients.get(initial.network);
    let record = (await store.get(initial.key)) ?? initial;
    if (client === undefined) return this.respond(record, 'Network is not served');
    const t = this.hubTimeoutMs;

    if (record.state === 'claimed' || record.state === 'broadcasting') {
      // Is it already on the ledger (we or someone else published it)?
      const known = await hubCall(() => client.api.getJoint(record.unitHash), t);
      if (known.kind === 'ok' && known.value.joint !== undefined) {
        record = await this.move(record, 'accepted', { data: { via: 'get_joint' } });
      } else if (known.kind !== 'ok') {
        await store.event({
          key: record.key,
          kind: 'hub_unavailable',
          data: { op: 'get_joint', error: known.error },
        });
        return this.respond(record);
      } else if (this.now() > record.publishDeadline) {
        record = await this.move(record, 'expired', { lastError: 'publication window closed' });
        return this.respond(record);
      } else {
        if (record.state === 'claimed') record = await this.move(record, 'broadcasting');
        if (record.unitJson === null) return this.respond(record, 'Unit body is no longer stored');
        const unit = JSON.parse(record.unitJson) as obyte.Unit;
        const posted = await hubCall(() => client.api.postJoint({ unit } as never), t);
        await store.event({ key: record.key, kind: 'post_joint', data: { outcome: posted.kind } });
        if (posted.kind === 'ok') {
          record = await this.move(record, 'accepted', {
            incrementAttempts: true,
            data: { response: posted.value },
          });
        } else if (posted.kind === 'hub_error' && isTransientPostError(posted.error)) {
          // The hub is still working on it or lacks context: not a rejection.
          // Stay in broadcasting; the next attempt resolves it via get_joint.
          this.log.info(
            { proofId: record.unitHash, hubError: posted.error },
            'broadcast not final yet (transient hub answer)',
          );
          return this.respond(record);
        } else if (posted.kind === 'hub_error') {
          // Definite rejection — unless the unit is known after all (e.g. posted earlier).
          const recheck = await hubCall(() => client.api.getJoint(record.unitHash), t);
          if (recheck.kind === 'ok' && recheck.value.joint !== undefined) {
            record = await this.move(record, 'accepted', {
              data: { via: 'get_joint after hub error' },
            });
          } else if (recheck.kind === 'ok') {
            record = await this.move(record, 'rejected', {
              lastError: posted.error,
              incrementAttempts: true,
            });
            this.log.warn(
              { proofId: record.unitHash, hubError: posted.error },
              'unit rejected by the network',
            );
            return this.respond(record);
          } else {
            return this.respond(record);
          }
        } else {
          // Unknown outcome: stay in broadcasting; the next attempt resolves it via get_joint.
          this.log.warn(
            { proofId: record.unitHash, error: posted.error },
            'broadcast outcome unknown',
          );
          return this.respond(record);
        }
      }
    }

    if (record.state === 'accepted') {
      const finality = await finalityOf(
        { hubTimeoutMs: this.hubTimeoutMs, historyProbeAddress: this.options.historyProbeAddress },
        client,
        record.unitHash,
      );
      if (finality === 'good') record = await this.move(record, 'stable_good');
      else if (finality === 'final_bad') {
        record = await this.move(record, 'final_bad', { lastError: 'double spend (final-bad)' });
        this.log.error({ proofId: record.unitHash }, 'settled unit became final-bad');
      }
    }
    return this.respond(record);
  }

  private async move(
    record: SettlementRecord,
    to: SettlementRecord['state'],
    patch: { lastError?: string; incrementAttempts?: boolean; data?: Record<string, unknown> } = {},
  ): Promise<SettlementRecord> {
    const next = await this.options.store.transition(record.key, [record.state], to, patch);
    if (next === undefined) {
      // Lost a race (another path moved it); continue from the stored state.
      return (await this.options.store.get(record.key)) ?? record;
    }
    this.log.info({ proofId: record.unitHash, from: record.state, to }, 'settlement state changed');
    return next;
  }

  private respond(record: SettlementRecord, problem?: string): SettleResponse {
    const network = record.network as Network;
    const base = { payer: record.payer, network, transaction: record.unitHash };
    const success =
      record.state === 'stable_good' ||
      (record.state === 'accepted' && this.finality === 'accepted');
    if (success) return { success: true, ...base, amount: record.amount };
    if (!TERMINAL_STATES.has(record.state)) {
      return {
        success: false,
        errorReason: EXACT_SETTLE_REASONS.pending,
        errorMessage: problem ?? `Settlement is ${record.state}`,
        // x402: settlement_pending carries a non-empty transaction; the unit
        // hash is deterministic even before the unit is broadcast.
        ...base,
      };
    }
    const reason =
      record.state === 'final_bad'
        ? EXACT_SETTLE_REASONS.finalBad
        : record.state === 'expired'
          ? EXACT_SETTLE_REASONS.expired
          : EXACT_SETTLE_REASONS.rejected;
    return {
      success: false,
      errorReason: reason,
      errorMessage: record.lastError ?? record.state,
      ...base,
    };
  }

  private key(network: string, unitHash: string): string {
    return networkKey(getNetwork(network), 'unit', unitHash);
  }
}

function unitHashOf(payload: PaymentPayload): string | undefined {
  const unit = payload.payload?.['unit'];
  const hash = unit && typeof unit === 'object' ? (unit as { unit?: unknown }).unit : undefined;
  return typeof hash === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(hash) ? hash : undefined;
}

function failure(network: Network, reason: string, message: string): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: '', network };
}
