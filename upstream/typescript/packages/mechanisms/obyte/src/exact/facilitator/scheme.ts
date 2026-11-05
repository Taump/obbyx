import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  DEFAULT_HUB_TIMEOUT_MS,
  DEFAULT_MAX_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_LAST_BALL_AGE_SECONDS,
  DEFAULT_PUBLISH_WINDOW_SECONDS,
  ERR_ASSET,
  ERR_DEFINITION,
  ERR_DEFINITION_REQUIRED,
  ERR_DOUBLE_SPEND,
  ERR_INVALID_NETWORK,
  ERR_INVALID_PAYLOAD,
  ERR_INVALID_REQUIREMENTS,
  ERR_INVALID_VERSION,
  ERR_LEDGER_UNAVAILABLE,
  ERR_PAYMENT_REUSED,
  ERR_PAYTO_IS_AA,
  ERR_PUBLICATION_WINDOW_EXPIRED,
  ERR_QUOTE_EXPIRED,
  ERR_REJECTED_BY_NETWORK,
  ERR_SETTLEMENT_PENDING,
  ERR_STALE,
  ERR_UNSUPPORTED_UNIT,
  OBYTE_CAIP_FAMILY,
  type ObyteNetwork,
  POSTED_UNIT_GRACE_SECONDS,
  SCHEME_EXACT,
  SUPPORTED_OBYTE_NETWORKS,
} from "../../constants";
import { checkLedger, finalityOf, isTransientPostError } from "../../ledger";
import {
  InMemoryObyteSettlementStore,
  type ObyteSettlementRecord,
  type ObyteSettlementState,
  type ObyteSettlementStore,
  TERMINAL_SETTLEMENT_STATES,
} from "../../settlementStore";
import type { ObyteHub } from "../../signer";
import type { Check, ExactUnitFacts, ObyteUnit, SigDefinition } from "../../types";
import { isSigDefinition, validateExactUnit } from "../../unit";
import { fail, hubCall, isObyteNetwork, pass } from "../../utils";
import {
  acceptedMatches,
  type ParsedExactRequirements,
  parseExactRequirements,
  unitHashOf,
  unitKey,
} from "../requirements";

/**
 * When `/settle` reports success: `stable` waits until the unit is stable and
 * good (final); `accepted` reports success once the hub accepted the unit
 * (faster, but the seller then bears the double-spend risk until stability).
 */
export type ObyteFinalityPolicy = "stable" | "accepted";

/** Facilitator configuration. */
export interface ExactObyteFacilitatorConfig {
  /** Hubs by network; a network without a hub is not served. */
  readonly hubs: Partial<Record<ObyteNetwork, ObyteHub>>;
  /** Accepted assets by network (`base` = bytes). Default: bytes on every served network. */
  readonly assets?: Partial<Record<ObyteNetwork, readonly string[]>>;
  /** Default `stable`. */
  readonly finality?: ObyteFinalityPolicy;
  /** Defaults to a process-local store. */
  readonly store?: ObyteSettlementStore;
  /** Addresses the facilitator controls; they may never be the payer. */
  readonly facilitatorAddresses?: readonly string[];
  readonly hubTimeoutMs?: number;
  /** Tolerated clock difference between client, hub and facilitator, seconds. */
  readonly maxClockSkewSeconds?: number;
  /** How long after the claim a unit may still be broadcast, seconds. */
  readonly publishWindowSeconds?: number;
  /** Oldest accepted `last_ball` of a payment unit, seconds. */
  readonly maxLastBallAgeSeconds?: number;
  /** Address with no history, for the mandatory `addresses` of history requests. */
  readonly historyProbeAddress?: string;
  /** Clock in unix seconds. */
  readonly now?: () => number;
}

/**
 * Obyte facilitator for the `exact` scheme. `verify` checks the signed unit
 * read-only (local profile, then ledger reads). `settle` claims it in the
 * store, broadcasts it and reports success only when the finality policy is
 * met; anything not final yet answers `settlement_pending` with the unit hash,
 * and a retry with the same payment resumes it (idempotent).
 */
export class ExactObyteScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_EXACT;
  readonly caipFamily = OBYTE_CAIP_FAMILY;
  private readonly config: ExactObyteFacilitatorConfig;
  private readonly store: ObyteSettlementStore;
  private readonly finality: ObyteFinalityPolicy;
  private readonly hubTimeoutMs: number;
  private readonly now: () => number;
  /** Serializes settlement of one unit inside this process. */
  private readonly inFlight = new Map<string, Promise<SettleResponse>>();
  /** Recipients known not to be autonomous agents (an address never becomes one). */
  private readonly plainRecipients = new Set<string>();

  /**
   * Creates the facilitator scheme.
   *
   * @param config - Hubs, store and policies.
   */
  constructor(config: ExactObyteFacilitatorConfig) {
    this.config = config;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.store = config.store ?? new InMemoryObyteSettlementStore(this.now);
    this.finality = config.finality ?? "stable";
    this.hubTimeoutMs = config.hubTimeoutMs ?? DEFAULT_HUB_TIMEOUT_MS;
  }

  /**
   * `/supported` extra: the finality policy and the accepted assets.
   *
   * @param network - Network identifier.
   * @returns The extra, or undefined for a network not served.
   */
  getExtra(network: string): Record<string, unknown> | undefined {
    if (!isObyteNetwork(network) || this.config.hubs[network] === undefined) return undefined;
    return { finality: this.finality, assets: [...this.assetsOf(network)] };
  }

  /**
   * The facilitator signs nothing in `exact`: the payer signs and pays fees.
   *
   * @param _ - Network identifier.
   * @returns No addresses.
   */
  getSigners(_: string): string[] {
    return [];
  }

  /**
   * Networks this instance serves.
   *
   * @returns CAIP-2 identifiers with a configured hub.
   */
  supportedNetworks(): ObyteNetwork[] {
    return SUPPORTED_OBYTE_NETWORKS.filter(n => this.config.hubs[n] !== undefined);
  }

  /**
   * Verifies a payment without changing anything.
   *
   * @param payload - Payment payload.
   * @param requirements - The server's requirements.
   * @returns Validity and the payer.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const checked = await this.check(payload, requirements);
    if (!checked.ok) {
      return { isValid: false, invalidReason: checked.reason, invalidMessage: checked.message };
    }
    return { isValid: true, payer: checked.value.facts.payer };
  }

  /**
   * Settles a payment: claim, broadcast, wait for finality. Idempotent per unit.
   *
   * @param payload - Payment payload.
   * @param requirements - The server's requirements.
   * @returns The settlement outcome.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network as Network;
    const unitHash = unitHashOf(payload);
    if (unitHash === undefined) return failure(network, ERR_INVALID_PAYLOAD, "Missing unit");
    if (!isObyteNetwork(requirements.network)) {
      return failure(network, ERR_INVALID_NETWORK, "Not an Obyte network");
    }
    const key = unitKey(requirements.network, unitHash);
    const existing = await this.store.get(key);
    if (existing !== undefined) {
      // A unit is bound to exactly one operation.
      const binding = (requirements.extra as { binding?: unknown } | undefined)?.binding;
      if (existing.binding !== binding || existing.payTo !== requirements.payTo) {
        return failure(network, ERR_PAYMENT_REUSED, "This payment is bound to another operation");
      }
      return this.drive(existing);
    }
    const checked = await this.check(payload, requirements);
    if (!checked.ok) {
      // The hub did not answer: nothing claimed, outcome unknown — retry the same payment.
      if (checked.reason === ERR_LEDGER_UNAVAILABLE) {
        return {
          success: false,
          errorReason: ERR_SETTLEMENT_PENDING,
          errorMessage: checked.message,
          transaction: unitHash,
          network,
        };
      }
      return failure(network, checked.reason, checked.message);
    }
    const { facts, req } = checked.value;
    const { record } = await this.store.claim({
      key,
      network: req.network,
      unitHash: facts.unitHash,
      binding: req.extra.binding,
      payer: facts.payer,
      payTo: req.payTo,
      asset: req.asset,
      amount: req.amount.toString(),
      unitJson: JSON.stringify(payload.payload["unit"]),
      publishDeadline:
        this.now() + (this.config.publishWindowSeconds ?? DEFAULT_PUBLISH_WINDOW_SECONDS),
    });
    return this.drive(record);
  }

  /**
   * Re-drives every non-terminal settlement once (run periodically, and at
   * start-up with a durable store).
   *
   * @param limit - Maximum number of settlements per call.
   * @returns The outcomes.
   */
  async recoverPending(limit = 100): Promise<SettleResponse[]> {
    const active = await this.store.listActive(limit);
    return Promise.all(active.map(r => this.drive(r)));
  }

  /**
   * Accepted assets of a network.
   *
   * @param network - Network identifier.
   * @returns The assets.
   */
  private assetsOf(network: ObyteNetwork): readonly string[] {
    return this.config.assets?.[network] ?? ["base"];
  }

  /**
   * All checks of `verify`: requirements, local unit profile, ledger.
   *
   * @param payload - Payment payload.
   * @param requirements - The server's requirements.
   * @returns Unit facts and parsed requirements, or the first failed check.
   */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Check<{ facts: ExactUnitFacts; req: ParsedExactRequirements }>> {
    if (payload.x402Version !== 2) return fail(ERR_INVALID_VERSION, "Only x402 v2 is supported");
    if (!acceptedMatches(payload, requirements)) {
      return fail(ERR_INVALID_REQUIREMENTS, "Accepted requirements differ from the server's");
    }
    const parsed = parseExactRequirements(requirements);
    if (!parsed.ok) return parsed;
    const req = parsed.value;
    const now = this.now();
    if (req.extra.validUntil < now) return fail(ERR_QUOTE_EXPIRED, "The payment offer has expired");
    const hub = this.config.hubs[req.network];
    if (hub === undefined) return fail(ERR_INVALID_NETWORK, "Network is not served");
    if (!this.assetsOf(req.network).includes(req.asset)) {
      return fail(ERR_ASSET, "Asset is not accepted by this facilitator");
    }

    const unit = payload.payload["unit"];
    const expectation = {
      network: req.network,
      payTo: req.payTo,
      asset: req.asset,
      amount: req.amount,
      binding: req.extra.binding,
      quoteId: req.extra.quoteId,
      ...(this.config.facilitatorAddresses
        ? { facilitatorAddresses: this.config.facilitatorAddresses }
        : {}),
    };
    let local = validateExactUnit(unit, expectation);
    if (!local.ok && local.reason === ERR_DEFINITION_REQUIRED) {
      const definition = await this.definitionOf(hub, unit);
      if (!definition.ok) return definition;
      local = validateExactUnit(unit, expectation, { authorDefinition: definition.value });
    }
    if (!local.ok) return local;
    const facts = local.value;

    const skew = this.config.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;
    if (Math.abs(facts.timestamp - now) > skew + req.maxTimeoutSeconds) {
      return fail(ERR_STALE, "Unit timestamp is outside the acceptance window");
    }
    // A payment to an autonomous agent triggers it, and the agent may send the
    // funds back: the unit would be valid and final, yet the seller unpaid.
    const recipient = await this.recipientIsNotAa(hub, req.payTo);
    if (!recipient.ok) return recipient;
    const ledger = await checkLedger(
      {
        hubTimeoutMs: this.hubTimeoutMs,
        maxLastBallAgeSeconds:
          this.config.maxLastBallAgeSeconds ?? DEFAULT_MAX_LAST_BALL_AGE_SECONDS,
        now: this.now,
      },
      hub,
      facts,
      unit as ObyteUnit,
    );
    if (!ledger.ok) return ledger;
    return pass({ facts, req });
  }

  /**
   * Refuses an autonomous-agent recipient.
   *
   * @param hub - Hub of the network.
   * @param payTo - Recipient.
   * @returns Success, or the failure.
   */
  private async recipientIsNotAa(hub: ObyteHub, payTo: string): Promise<Check<null>> {
    if (this.plainRecipients.has(payTo)) return pass(null);
    const res = await hubCall(() => hub.getDefinition(payTo), this.hubTimeoutMs);
    if (res.kind !== "ok") {
      return fail(ERR_LEDGER_UNAVAILABLE, `Cannot read the payTo definition: ${res.error}`);
    }
    if (Array.isArray(res.value) && res.value[0] === "autonomous agent") {
      return fail(ERR_PAYTO_IS_AA, "payTo is an autonomous agent");
    }
    // An unused address has no definition yet (null): accepted, not cached.
    if (res.value !== null && res.value !== undefined) this.plainRecipients.add(payTo);
    return pass(null);
  }

  /**
   * Reads the payer's definition when the unit does not embed it.
   *
   * @param hub - Hub of the network.
   * @param unit - The unit.
   * @returns The single-sig definition, or the failure.
   */
  private async definitionOf(hub: ObyteHub, unit: unknown): Promise<Check<SigDefinition>> {
    const address = (unit as { authors?: { address?: unknown }[] }).authors?.[0]?.address;
    if (typeof address !== "string") return fail(ERR_UNSUPPORTED_UNIT, "Malformed author");
    const res = await hubCall(() => hub.getDefinition(address), this.hubTimeoutMs);
    if (res.kind !== "ok")
      return fail(ERR_LEDGER_UNAVAILABLE, `Cannot read definition: ${res.error}`);
    if (!isSigDefinition(res.value)) {
      return fail(ERR_DEFINITION, "Payer definition is unknown or not a single-sig definition");
    }
    return pass(res.value);
  }

  /**
   * Runs one pass of the state machine for a settlement, joined by concurrent callers.
   *
   * @param record - The settlement.
   * @returns The outcome.
   */
  private drive(record: ObyteSettlementRecord): Promise<SettleResponse> {
    const running = this.inFlight.get(record.key);
    if (running !== undefined) return running;
    const promise = this.step(record).finally(() => this.inFlight.delete(record.key));
    this.inFlight.set(record.key, promise);
    return promise;
  }

  /**
   * Publish (or find) the unit, then follow it to finality. Anything unknown
   * leaves the record where it is, for a retry or {@link recoverPending}.
   *
   * @param initial - The settlement.
   * @returns The outcome.
   */
  private async step(initial: ObyteSettlementRecord): Promise<SettleResponse> {
    let record = (await this.store.get(initial.key)) ?? initial;
    const hub = isObyteNetwork(record.network) ? this.config.hubs[record.network] : undefined;
    if (hub === undefined) return this.respond(record, "Network is not served");
    if (record.state === "claimed" || record.state === "broadcasting") {
      record = await this.publish(hub, record);
    }
    if (record.state === "accepted") record = await this.awaitFinality(hub, record);
    return this.respond(record);
  }

  /**
   * Before acceptance: find the unit on the ledger, otherwise post it while
   * the publication window is open.
   *
   * @param hub - Hub of the network.
   * @param record - The settlement.
   * @returns The updated settlement.
   */
  private async publish(
    hub: ObyteHub,
    record: ObyteSettlementRecord,
  ): Promise<ObyteSettlementRecord> {
    const known = await hubCall(() => hub.getJoint(record.unitHash), this.hubTimeoutMs);
    if (known.kind !== "ok") return record;
    if (known.value.joint !== undefined) return this.move(record, "accepted");
    if (this.now() > record.publishDeadline) return this.afterPublishWindow(record);
    return this.broadcast(hub, record);
  }

  /**
   * Past the window a unit is never posted. One never posted expires; one
   * posted (outcome unknown) may still land, so it is looked for during a grace
   * period first.
   *
   * @param record - The settlement.
   * @returns The updated settlement.
   */
  private async afterPublishWindow(record: ObyteSettlementRecord): Promise<ObyteSettlementRecord> {
    if (record.attempts === 0) {
      return this.move(record, "expired", { lastError: "publication window closed" });
    }
    if (this.now() > record.publishDeadline + POSTED_UNIT_GRACE_SECONDS) {
      return this.move(record, "expired", { lastError: "posted, but never seen on the ledger" });
    }
    await this.store.touch(record.key);
    return record;
  }

  /**
   * Posts the unit once and classifies the hub's answer.
   *
   * @param hub - Hub of the network.
   * @param initial - The settlement.
   * @returns The updated settlement.
   */
  private async broadcast(
    hub: ObyteHub,
    initial: ObyteSettlementRecord,
  ): Promise<ObyteSettlementRecord> {
    // Counted before posting: a crash mid-post still counts as "maybe sent".
    const record = await this.move(initial, "broadcasting", { incrementAttempts: true });
    if (record.state !== "broadcasting") return record;
    const unit = JSON.parse(record.unitJson) as ObyteUnit;
    const posted = await hubCall(() => hub.postJoint({ unit }), this.hubTimeoutMs);
    if (posted.kind === "ok") return this.move(record, "accepted");
    // Unknown outcome or transient answer: resolved by get_joint on the next pass.
    if (posted.kind === "unknown" || isTransientPostError(posted.error)) return record;
    // Definite rejection — unless the unit is known after all.
    const recheck = await hubCall(() => hub.getJoint(record.unitHash), this.hubTimeoutMs);
    if (recheck.kind !== "ok") return record;
    if (recheck.value.joint !== undefined) return this.move(record, "accepted");
    return this.move(record, "rejected", { lastError: posted.error });
  }

  /**
   * After acceptance: stable and good, final-bad, or still waiting.
   *
   * @param hub - Hub of the network.
   * @param record - The settlement.
   * @returns The updated settlement.
   */
  private async awaitFinality(
    hub: ObyteHub,
    record: ObyteSettlementRecord,
  ): Promise<ObyteSettlementRecord> {
    const finality = await finalityOf(hub, record.unitHash, {
      hubTimeoutMs: this.hubTimeoutMs,
      ...(this.config.historyProbeAddress === undefined
        ? {}
        : { historyProbeAddress: this.config.historyProbeAddress }),
    });
    if (finality === "good") return this.move(record, "stable_good");
    if (finality === "final_bad") {
      return this.move(record, "final_bad", { lastError: "double spend (final-bad)" });
    }
    await this.store.touch(record.key);
    return record;
  }

  /**
   * Compare-and-set transition; a lost race continues from the stored state.
   *
   * @param record - The settlement.
   * @param to - New state.
   * @param patch - Changes applied with it.
   * @param patch.lastError - Error to record.
   * @param patch.incrementAttempts - Count a broadcast attempt.
   * @returns The stored settlement.
   */
  private async move(
    record: ObyteSettlementRecord,
    to: ObyteSettlementState,
    patch: { lastError?: string; incrementAttempts?: boolean } = {},
  ): Promise<ObyteSettlementRecord> {
    const next = await this.store.transition(record.key, [record.state], to, patch);
    return next ?? (await this.store.get(record.key)) ?? record;
  }

  /**
   * Maps a settlement to the x402 response.
   *
   * @param record - The settlement.
   * @param problem - Why it could not proceed, if known.
   * @returns The response.
   */
  private respond(record: ObyteSettlementRecord, problem?: string): SettleResponse {
    const base = {
      payer: record.payer,
      network: record.network as Network,
      transaction: record.unitHash,
    };
    const success =
      record.state === "stable_good" ||
      (record.state === "accepted" && this.finality === "accepted");
    if (success) return { success: true, ...base, amount: record.amount };
    if (!TERMINAL_SETTLEMENT_STATES.has(record.state)) {
      // The unit hash is known before broadcast, so `transaction` is never empty.
      return {
        success: false,
        errorReason: ERR_SETTLEMENT_PENDING,
        errorMessage: problem ?? `Settlement is ${record.state}`,
        ...base,
      };
    }
    const reason =
      record.state === "final_bad"
        ? ERR_DOUBLE_SPEND
        : record.state === "expired"
          ? ERR_PUBLICATION_WINDOW_EXPIRED
          : ERR_REJECTED_BY_NETWORK;
    return {
      success: false,
      errorReason: reason,
      errorMessage: record.lastError ?? record.state,
      ...base,
    };
  }
}

/**
 * A settlement failure that has no unit hash.
 *
 * @param network - Network identifier.
 * @param reason - Reason code.
 * @param message - Explanation.
 * @returns The response.
 */
function failure(network: Network, reason: string, message: string): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: "", network };
}
