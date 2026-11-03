import { createHash } from 'node:crypto';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  type ChannelParams,
  OBYTE_CAIP_FAMILY,
  getNetwork,
  networkKey,
  parseChannelDefinition,
  verifySignedPackage,
} from '@obbyx/obyte';
import { type Logger, moduleLogger, withLogContext } from '@obbyx/obyte/logger';
import type obyte from 'obyte';
import { acceptedMatches, canonical } from '../exact/requirements.js';
import { hubCall } from '../hub/hub-call.js';
import { KeyedQueue } from '../util/keyed-queue.js';
import { parseStateVars } from '../hub/schemas.js';
import type { WatcherGateway } from './gateway.js';
import {
  BATCH_REASONS as R,
  BATCH_SCHEME,
  type ParsedBatchRequirements,
  type VoucherMessage,
  parseBatchRequirements,
  voucherMessageSchema,
} from './requirements.js';
import type { SettlementEvent } from '../exact/store.js';
import type { BatchStore, CommitmentRow } from './store.js';

/**
 * x402 `batch-settlement` facilitator for Obyte AA payment channels
 * (ADR-0003, facilitator-managed vouchers).
 *
 * The client (party B) signs cumulative vouchers `amount_spent` for the
 * channel AA with the seller (party A = payTo). `/settle` stores the voucher;
 * it succeeds only after the SELLER'S WATCHER has durably stored it (sync ack),
 * so the component that defends the channel always holds the latest proof.
 * No value moves on-chain here; the watcher closes channels later.
 *
 * MVP rules: unidirectional channel, one in-flight voucher per channel,
 * `amount_spent == committed + price`, `payment_amount == price`.
 */
export interface BatchObyteFacilitatorOptions {
  readonly clients: ReadonlyMap<string, obyte.Client>;
  readonly store: BatchStore;
  readonly gateway: WatcherGateway;
  readonly logger: Logger;
  readonly allowedAssets: ReadonlyMap<string, ReadonlySet<string>>;
  /** Lowest channel timeout accepted (also advertised in /supported). */
  readonly minChannelTimeoutSeconds: number;
  readonly hubTimeoutMs?: number;
  readonly ackTimeoutMs?: number;
  /** Payment event journal (logging stream 2); e.g. the facilitator's `events` table. */
  readonly events?: (event: SettlementEvent) => Promise<void>;
  readonly now?: () => number;
}

/** A voucher whose signature, binding, price and channel parameters are verified. */
interface Authenticated {
  readonly req: ParsedBatchRequirements;
  readonly voucher: VoucherMessage;
  readonly payer: string;
  readonly channel: ChannelParams;
  readonly packageJson: string;
  readonly packageHash: string;
}

/** A new voucher that also passed the live-state checks. */
interface Checked extends Authenticated {
  readonly balance: bigint;
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };
const fail = (reason: string, message: string) => ({ ok: false as const, reason, message });

export class BatchObyteFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SCHEME;
  readonly caipFamily = OBYTE_CAIP_FAMILY;
  private readonly log: Logger;
  private readonly hubTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;
  /** Channel definitions are immutable: cache them. */
  private readonly definitions = new Map<string, ChannelParams>();
  /** One settle at a time per channel inside this process. */
  /** One voucher at a time per channel inside this process (the DB enforces it across processes). */
  private readonly channels = new KeyedQueue();

  constructor(private readonly options: BatchObyteFacilitatorOptions) {
    this.log = moduleLogger(options.logger, 'x402.batch', { scheme: BATCH_SCHEME });
    this.hubTimeoutMs = options.hubTimeoutMs ?? 15_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  getExtra(network: Network): Record<string, unknown> {
    return {
      voucherManager: 'facilitator',
      minTimeout: this.options.minChannelTimeoutSeconds,
      assets: [...(this.options.allowedAssets.get(network) ?? [])],
    };
  }

  /** The facilitator never signs channel triggers (ADR-0001). */
  getSigners(): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return withLogContext({ scheme: BATCH_SCHEME, network: requirements.network }, async () => {
      const checked = await this.check(payload, requirements);
      if (!checked.ok) {
        this.log.info({ reason: checked.reason, detail: checked.message }, 'verify rejected');
        return { isValid: false, invalidReason: checked.reason, invalidMessage: checked.message };
      }
      const c = checked.value;
      const channelKey = this.channelKey(c.req.network.caip2, c.voucher.aa_address);
      const existing = await this.options.store.commitmentByHash(c.packageHash);
      if (existing === undefined) {
        const channel = await this.options.store.channel(channelKey);
        const committed = channel?.period === c.voucher.period ? channel.committed : 0n;
        if (channel?.period === c.voucher.period && channel.pendingSeq !== null) {
          return {
            isValid: false,
            invalidReason: R.busy,
            invalidMessage: 'Another voucher is in flight',
          };
        }
        if (BigInt(c.voucher.amount_spent) !== committed + c.req.amount) {
          return {
            isValid: false,
            invalidReason: R.cumulative,
            invalidMessage: `Expected amount_spent ${committed + c.req.amount}`,
            extra: { chargedCumulativeAmount: committed.toString() },
          };
        }
      }
      return { isValid: true, payer: c.payer, extra: { channel: c.voucher.aa_address } };
    });
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return withLogContext({ scheme: BATCH_SCHEME, network: requirements.network }, async () => {
      const network = requirements.network as Network;
      const auth = await this.authenticate(payload, requirements);
      const stored = auth.ok
        ? await this.options.store.commitmentByHash(auth.value.packageHash)
        : undefined;
      const checked: Check<Authenticated & { readonly balance?: bigint }> =
        auth.ok && stored === undefined ? await this.newVoucherChecks(auth.value) : auth;
      if (!checked.ok) {
        await this.emit({
          key: `${requirements.network}:batch:${requirements.payTo}`,
          kind: 'voucher_refused',
          data: { reason: checked.reason, stage: 'verify' },
        });
        return failure(network, checked.reason, checked.message);
      }
      const c = checked.value;
      const channelKey = this.channelKey(c.req.network.caip2, c.voucher.aa_address);
      return withLogContext({ aa: c.voucher.aa_address, proofId: c.packageHash }, () =>
        this.channels.run(channelKey, () => this.settleLocked(c, channelKey, network)),
      );
    });
  }

  private async newVoucherChecks(a: Authenticated): Promise<Check<Checked>> {
    const live = await this.liveChecks(a);
    return live.ok ? { ok: true, value: { ...a, balance: live.value.balance } } : live;
  }

  private async settleLocked(
    c: Authenticated & { readonly balance?: bigint },
    channelKey: string,
    network: Network,
  ): Promise<SettleResponse> {
    const store = this.options.store;
    let commitment = await store.commitmentByHash(c.packageHash);
    if (commitment !== undefined && commitment.binding !== c.voucher.binding) {
      return failure(
        network,
        'invalid_payment_reused',
        'This voucher is bound to another operation',
      );
    }
    if (commitment === undefined) {
      const appended = await store.appendPending({
        channelKey,
        network: c.req.network.caip2,
        aa: c.voucher.aa_address,
        payTo: c.req.payTo,
        payer: c.payer,
        asset: c.req.asset,
        period: c.voucher.period,
        amountSpent: BigInt(c.voucher.amount_spent),
        paymentAmount: BigInt(c.voucher.payment_amount),
        binding: c.voucher.binding,
        packageHash: c.packageHash,
        packageJson: c.packageJson,
      });
      if (!appended.ok) {
        const reason =
          appended.reason === 'channel_busy'
            ? R.busy
            : appended.reason === 'period_mismatch'
              ? R.period
              : R.cumulative;
        await this.emit({
          key: channelKey,
          kind: 'voucher_refused',
          data: {
            reason,
            amountSpent: c.voucher.amount_spent,
            committed: appended.committed.toString(),
          },
        });
        return {
          ...failure(network, reason, `Voucher rejected: ${appended.reason}`),
          extra: { chargedCumulativeAmount: appended.committed.toString() },
        };
      }
      commitment = appended.commitment;
      await this.emit({
        key: channelKey,
        kind: 'voucher_pending',
        data: {
          seq: commitment.seq,
          period: commitment.period,
          amountSpent: commitment.amountSpent.toString(),
        },
      });
      this.log.info(
        { seq: commitment.seq, amountSpent: commitment.amountSpent.toString() },
        'voucher pending',
      );
    }

    if (commitment.state === 'pending') {
      const delivered = await this.options.gateway.deliver(commitment, this.ackTimeoutMs);
      if (delivered !== 'acked') {
        // Stored here but not yet confirmed by the seller's watcher: the outcome
        // is unknown to the client → settlement_pending (x402: non-empty
        // transaction), retried with the SAME voucher. Distinct from the
        // definite refusal `…_watcher_unavailable` at verification.
        this.log.warn(
          { seq: commitment.seq },
          'watcher did not ack in time; voucher stays pending',
        );
        await this.emit({ key: channelKey, kind: 'ack_timeout', data: { seq: commitment.seq } });
        return {
          success: false,
          errorReason: 'settlement_pending',
          errorMessage:
            "Waiting for the seller's watcher to store this voucher; retry with the same voucher",
          transaction: commitmentIdOf(network, commitment),
          network,
          payer: c.payer,
        };
      }
      commitment =
        (await store.commit(commitment.seq, {
          payTo: commitment.payTo,
          network: commitment.network,
        })) ?? commitment;
      this.log.info({ seq: commitment.seq }, 'voucher committed (watcher ack)');
      await this.emit({
        key: channelKey,
        kind: 'voucher_committed',
        data: {
          seq: commitment.seq,
          period: commitment.period,
          amountSpent: commitment.amountSpent.toString(),
        },
      });
    }
    return this.success(network, c, commitment);
  }

  private success(
    network: Network,
    c: Authenticated & { readonly balance?: bigint },
    commitment: CommitmentRow,
  ): SettleResponse {
    return {
      success: true,
      payer: c.payer,
      network,
      transaction: '',
      amount: '',
      extra: {
        chargedAmount: commitment.paymentAmount.toString(),
        commitmentId: commitmentIdOf(network, commitment),
        channelState: {
          channelId: commitment.aa,
          period: commitment.period,
          ...(c.balance === undefined ? {} : { balance: c.balance.toString() }),
          chargedCumulativeAmount: commitment.amountSpent.toString(),
        },
      },
    };
  }

  // --- verification -----------------------------------------------------------

  /** Stateless checks: shape, signature, binding, price, the channel's on-chain parameters. */
  private async authenticate(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Check<Authenticated>> {
    if (payload.x402Version !== 2)
      return fail('invalid_x402_version', 'Only x402 v2 is supported here');
    if (!acceptedMatches(payload, requirements)) {
      return fail(
        'invalid_payment_requirements',
        'Accepted requirements differ from the server requirements',
      );
    }
    const parsed = parseBatchRequirements(requirements);
    if (!parsed.ok) return fail(parsed.reason, parsed.message);
    const req = parsed.value;
    if (!this.options.allowedAssets.get(req.network.caip2)?.has(req.asset)) {
      return fail('invalid_batch_settlement_obyte_asset', 'Asset is not accepted');
    }
    const client = this.options.clients.get(req.network.caip2);
    if (client === undefined) return fail('invalid_network', 'Network is not served');

    // Voucher signature (bound to the network) and content.
    const pkg = payload.payload['signedPackage'];
    const verified = verifySignedPackage<unknown>(pkg, { network: req.network });
    if (!verified.ok) return fail(R.signature, verified.message);
    const voucher = voucherMessageSchema.safeParse(verified.value.message);
    if (!voucher.success)
      return fail(R.payload, `Invalid voucher: ${voucher.error.issues[0]?.message}`);
    const v = voucher.data;
    if (v.binding !== req.extra.binding)
      return fail(R.binding, 'Voucher is bound to another operation');
    if (BigInt(v.payment_amount) !== req.amount)
      return fail(R.amount, 'payment_amount must equal the price');

    // Channel binding: on-chain definition → payTo is party A, signer is party B.
    const params = await this.channelParams(client, v.aa_address);
    if (!params.ok) return params;
    const p = params.value;
    if (p.addressA !== req.payTo || p.addressB !== verified.value.signer || p.asset !== req.asset) {
      return fail(R.channelParams, 'Channel does not connect this payer to payTo in this asset');
    }
    const minTimeout = Math.max(this.options.minChannelTimeoutSeconds, req.extra.minTimeout);
    if (p.timeout < minTimeout)
      return fail(R.timeout, `Channel timeout must be at least ${minTimeout} s`);

    const packageJson = canonical(pkg);
    return {
      ok: true,
      value: {
        req,
        voucher: v,
        payer: verified.value.signer,
        channel: p,
        packageJson,
        packageHash: createHash('sha256').update(packageJson).digest('hex'),
      },
    };
  }

  /**
   * Checks that depend on time and live state: offer validity, channel period,
   * closing flag, confirmed deposit, the seller's watcher. Applied only to a
   * NEW voucher: one already stored is re-delivered regardless, because its
   * outcome is decided by the watcher's ack (refusing it now would report a
   * definite failure for a voucher the seller may still redeem).
   */
  private async liveChecks(c: Authenticated): Promise<Check<{ balance: bigint }>> {
    const { req, voucher: v } = c;
    if (req.extra.validUntil < this.now())
      return fail(R.quoteExpired, 'The payment offer has expired');
    const client = this.options.clients.get(req.network.caip2);
    if (client === undefined) return fail('invalid_network', 'Network is not served');
    // Channel state: same period, not closing, enough confirmed deposit.
    const vars = await hubCall(
      () => client.api.getAaStateVars({ address: v.aa_address }),
      this.hubTimeoutMs,
    );
    if (vars.kind !== 'ok') return fail(R.ledger, `state vars: ${vars.error}`);
    const state = parseStateVars(vars.value);
    if (state === undefined) return fail(R.ledger, 'state vars: malformed hub answer');
    if (state['period'] !== v.period)
      return fail(R.period, `Channel period is ${String(state['period'])}`);
    if (state['close_initiated_by'] !== undefined)
      return fail(R.closing, 'Channel is being closed');
    const balance = BigInt(typeof state['balanceB'] === 'number' ? state['balanceB'] : 0);
    if (BigInt(v.amount_spent) > balance)
      return fail(R.balance, 'amount_spent exceeds the confirmed deposit');

    // The seller's watcher must be able to defend the channel (fail-closed).
    const health = this.options.gateway.health(req.payTo, req.network.caip2, v.aa_address);
    if (!health.ok && health.closing === true)
      return fail(R.closing, health.reason ?? 'The seller is closing this channel');
    if (!health.ok)
      return fail(R.watcher, health.reason ?? "The seller's watcher is not available");

    return { ok: true, value: { balance } };
  }

  /** Full verification of a new voucher. */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Check<Checked>> {
    const auth = await this.authenticate(payload, requirements);
    if (!auth.ok) return auth;
    const live = await this.liveChecks(auth.value);
    if (!live.ok) return live;
    return { ok: true, value: { ...auth.value, balance: live.value.balance } };
  }

  private async channelParams(client: obyte.Client, aa: string): Promise<Check<ChannelParams>> {
    const cached = this.definitions.get(aa);
    if (cached !== undefined) return { ok: true, value: cached };
    const res = await hubCall(() => client.api.getDefinition(aa), this.hubTimeoutMs);
    if (res.kind !== 'ok') return fail(R.ledger, `definition: ${res.error}`);
    if (res.value === null || res.value === undefined)
      return fail(R.channel, 'Channel AA is not defined on the ledger');
    const parsed = parseChannelDefinition(aa, res.value);
    if (!parsed.ok) return fail(R.channel, parsed.message);
    this.definitions.set(aa, parsed.value);
    return { ok: true, value: parsed.value };
  }

  /** The journal must never break a payment: failures are logged, not thrown. */
  private async emit(event: SettlementEvent): Promise<void> {
    try {
      await this.options.events?.(event);
    } catch (err) {
      this.log.error({ err, kind: event.kind }, 'cannot write payment event');
    }
  }

  private channelKey(network: string, aa: string): string {
    return networkKey(getNetwork(network), 'aa', aa);
  }
}

function commitmentIdOf(network: Network, c: CommitmentRow): string {
  return `${network}:${c.aa}:${c.period}:${c.amountSpent}`;
}

function failure(network: Network, reason: string, message: string): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: '', network };
}
