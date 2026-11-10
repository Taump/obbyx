import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  CHANNEL_BASE_AA,
  CHANNEL_BASE_AA_NETWORKS,
  type ChannelParams,
  OBYTE_CAIP_FAMILY,
  ObbyxError,
  getNetwork,
  networkKey,
  parseChannelDefinition,
  verifyVoucherPackage,
} from '@obbyx/obyte';
import { type Logger, moduleLogger, withLogContext } from '@obbyx/obyte/logger';
import type obyte from 'obyte';
import { acceptedMatches, canonical } from '../exact/requirements.js';
import { hubCall } from '../hub/hub-call.js';
import { KeyedQueue } from '../util/keyed-queue.js';
import { parseStateVars } from '../hub/schemas.js';
import type { WatcherGateway } from './gateway.js';
import { packageHashOf } from './watcher-protocol.js';
import {
  BATCH_REASONS as R,
  BATCH_SCHEME,
  type ParsedBatchRequirements,
  type VoucherMessage,
  parseBatchRequirements,
  voucherMessageSchema,
} from './requirements.js';
import type { SettlementEvent } from '../exact/store.js';
import type { BatchStore, CommitmentMeta, CommitmentRow } from './store.js';

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
  /** Lowest channel timeout accepted (also advertised in /supported); at least {@link MIN_CHANNEL_TIMEOUT_FLOOR}. */
  readonly minChannelTimeoutSeconds: number;
  readonly hubTimeoutMs?: number;
  readonly ackTimeoutMs?: number;
  /** Payment event journal (logging stream 2); e.g. the facilitator's `events` table. */
  readonly events?: (event: SettlementEvent) => Promise<void>;
  readonly now?: () => number;
}

/**
 * The watcher reacts to a close only once it is stable (~1-2 h lag): a
 * shorter dispute window could expire before the seller can answer it.
 */
const MIN_CHANNEL_TIMEOUT_FLOOR = 3600;

/** A voucher whose signature, binding, price and channel parameters are verified. */
interface Authenticated {
  readonly req: ParsedBatchRequirements;
  readonly voucher: VoucherMessage;
  readonly payer: string;
  readonly packageJson: string;
  readonly packageHash: string;
}

/** A new voucher that also passed the live-state checks. */
interface Checked extends Authenticated {
  readonly balance: bigint;
}

/**
 * `unknown`: the failure may only mean that our hub is unreachable or lags
 * behind the ledger. A NEW voucher is refused anyway; a voucher already held
 * pending is not (verify: valid, settle: `settlement_pending`).
 */
type Fail = { ok: false; reason: string; message: string; unknown: boolean };
type Check<T> = { ok: true; value: T } | Fail;
const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (reason: string, message: string, unknown = reason === R.ledger): Fail => ({
  ok: false,
  reason,
  message,
  unknown,
});

/** A journal entry stored for this very operation, with its payer. */
interface Held {
  readonly row: CommitmentMeta;
  readonly payer: string;
}

/** What verify and settle do with a payload (see {@link BatchObyteFacilitator.resolve}). */
type Resolved =
  | { kind: 'refused'; reason: string; message: string }
  | { kind: 'committed'; held: Held }
  | { kind: 'unknown'; held: Held; message: string }
  | { kind: 'stored'; c: Authenticated; row: CommitmentMeta }
  | { kind: 'new'; c: Checked };

export class BatchObyteFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SCHEME;
  readonly caipFamily = OBYTE_CAIP_FAMILY;
  private readonly log: Logger;
  private readonly hubTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;
  /** Channel definitions are immutable: cache them. */
  private readonly definitions = new Map<string, ChannelParams>();
  /** One voucher at a time per channel inside this process (the DB enforces it across processes). */
  private readonly channels = new KeyedQueue();

  constructor(private readonly options: BatchObyteFacilitatorOptions) {
    if (!(options.minChannelTimeoutSeconds >= MIN_CHANNEL_TIMEOUT_FLOOR)) {
      throw new ObbyxError(
        'invalid_config',
        `minChannelTimeoutSeconds must be at least ${MIN_CHANNEL_TIMEOUT_FLOOR}`,
      );
    }
    this.log = moduleLogger(options.logger, 'x402.batch', { scheme: BATCH_SCHEME });
    this.hubTimeoutMs = options.hubTimeoutMs ?? 15_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  getExtra(network: Network): Record<string, unknown> {
    return {
      voucherManager: 'facilitator',
      /** Channels are instances of this base AA (v1.2); legacy (v1.1) channels are refused. */
      baseAa: CHANNEL_BASE_AA,
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
      const r = await this.resolve(payload, requirements);
      switch (r.kind) {
        case 'committed':
          return valid(r.held.payer, r.held.row.aa);
        case 'unknown':
          this.log.info({ detail: r.message }, 'stored voucher not re-checked; left to settle');
          return valid(r.held.payer, r.held.row.aa);
        case 'refused':
          this.log.info({ reason: r.reason, detail: r.message }, 'verify rejected');
          return { isValid: false, invalidReason: r.reason, invalidMessage: r.message };
        case 'stored': {
          if (r.row.state === 'cancelled') {
            const why = await this.whyCancelled(r.c, r.row);
            return { isValid: false, invalidReason: why.reason, invalidMessage: why.message };
          }
          // Under the channel lock: a cancellation must not interleave with a settle.
          const live = await this.channels.run(r.row.channelKey, () => this.recheck(r.c, r.row));
          if (!live.ok && !live.unknown) {
            this.log.info({ reason: live.reason, detail: live.message }, 'verify rejected');
            return { isValid: false, invalidReason: live.reason, invalidMessage: live.message };
          }
          if (!live.ok) {
            this.log.info(
              { detail: live.message },
              'stored voucher not re-checked; left to settle',
            );
          }
          return valid(r.c.payer, r.row.aa);
        }
        case 'new': {
          const { c } = r;
          const channel = await this.options.store.channel(this.channelKey(c));
          const current = channel?.period === c.voucher.period ? channel : undefined;
          if (current?.pendingSeq != null) {
            return {
              isValid: false,
              invalidReason: R.busy,
              invalidMessage: 'Another voucher is in flight',
            };
          }
          const committed = current?.committed ?? 0n;
          if (BigInt(c.voucher.amount_spent) !== committed + c.req.amount) {
            return {
              isValid: false,
              invalidReason: R.cumulative,
              invalidMessage: `Expected amount_spent ${committed + c.req.amount}`,
              extra: { chargedCumulativeAmount: committed.toString() },
            };
          }
          return valid(c.payer, c.voucher.aa_address);
        }
      }
    });
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return withLogContext({ scheme: BATCH_SCHEME, network: requirements.network }, async () => {
      const network = requirements.network as Network;
      const r = await this.resolve(payload, requirements);
      switch (r.kind) {
        case 'committed':
          return this.success(network, r.held.payer, r.held.row);
        case 'unknown':
          return pendingSettle(network, r.held.row, r.held.payer, r.message);
        case 'refused':
          await this.emit({
            key: `${requirements.network}:batch:${requirements.payTo}`,
            kind: 'voucher_refused',
            data: { reason: r.reason, stage: 'verify' },
          });
          return failure(network, r.reason, r.message);
        case 'stored':
        case 'new': {
          const { c } = r;
          const channelKey = this.channelKey(c);
          return withLogContext({ aa: c.voucher.aa_address, proofId: c.packageHash }, () =>
            this.channels.run(channelKey, () => this.settleLocked(c, channelKey, network)),
          );
        }
      }
    });
  }

  /**
   * The checks shared by verify and settle, before any write.
   * - A journal entry of this exact package stored for this very operation
   *   (looked up by package hash BEFORE any other check):
   *   COMMITTED → replayed as success whatever the current rules or channel
   *   state (it was acked and charged; also covers vouchers accepted under
   *   older rules). PENDING → authenticated again (strict profile, v1.2), but a
   *   failure that may only reflect our hub is `unknown`, not a refusal; a
   *   definite refusal cancels the entry (frees the channel, never delivered
   *   again) unless the watcher's ack already committed it.
   * - A NEW voucher always takes the full path: authentication and the live
   *   checks (quote, channel state, balance, watcher).
   */
  private async resolve(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Resolved> {
    const held = await this.held(payload, requirements);
    if (held?.row.state === 'committed') return { kind: 'committed', held };
    const auth = await this.authenticate(payload, requirements);
    if (!auth.ok) {
      const refused = { kind: 'refused', reason: auth.reason, message: auth.message } as const;
      if (held?.row.state !== 'pending') return refused;
      if (auth.unknown) return { kind: 'unknown', held, message: auth.message };
      const { row } = held;
      const after = await this.channels.run(row.channelKey, () => this.cancel(row, auth.reason));
      return after?.state === 'committed'
        ? { kind: 'committed', held: { ...held, row: after } }
        : refused;
    }
    if (held !== undefined) return { kind: 'stored', c: auth.value, row: held.row };
    const checked = await this.newVoucherChecks(auth.value);
    return checked.ok
      ? { kind: 'new', c: checked.value }
      : { kind: 'refused', reason: checked.reason, message: checked.message };
  }

  /** The journal entry of this package, if it was stored for this very operation. */
  private async held(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Held | undefined> {
    const pkg = payload.payload['signedPackage'];
    if (pkg === null || typeof pkg !== 'object') return undefined;
    let hash: string;
    try {
      hash = packageHashOf(pkg);
    } catch {
      return undefined;
    }
    const row = await this.options.store.commitmentMeta(hash);
    const extra = requirements.extra as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      payload.x402Version !== 2 ||
      requirements.scheme !== BATCH_SCHEME ||
      !acceptedMatches(payload, requirements) ||
      row.network !== requirements.network ||
      row.payTo !== requirements.payTo ||
      row.binding !== extra?.['binding'] ||
      row.paymentAmount.toString() !== requirements.amount
    ) {
      return undefined;
    }
    const channel = await this.options.store.channel(row.channelKey);
    if (channel?.asset !== requirements.asset) return undefined;
    return { row, payer: channel.payer };
  }

  /**
   * Re-reads the channel of a stored PENDING voucher before it is reported
   * valid or handed to the watcher again. Runs under the channel lock.
   * Returns the entry to go on with (still pending, or committed if an ack
   * won the race), or:
   * - `period_mismatch`: the channel is in a LATER period, so the voucher is
   *   worthless to the seller; the entry is cancelled (frees the channel);
   * - `unknown` (ledger): the period cannot be read or is lower (lagging hub).
   * A closing channel, quote expiry and watcher health are not checked: the
   * watcher's ack decides (it acks during the client's close, nacks once its
   * own close or confirm is under way).
   */
  private async recheck(a: Authenticated, pending: CommitmentMeta): Promise<Check<CommitmentMeta>> {
    const state = await this.channelState(a);
    if (!state.ok) return state;
    const period = state.value['period'];
    if (period === pending.period) return ok(pending);
    if (!Number.isSafeInteger(period) || (period as number) < pending.period) {
      return fail(R.ledger, `state vars: channel period ${String(period)} is not readable`);
    }
    const after = await this.cancel(pending, 'period_closed');
    if (after?.state === 'committed') return ok(after);
    return fail(R.period, `Channel period is ${String(period)}`);
  }

  /**
   * Cancels a stored pending entry the facilitator refuses definitely (frees
   * its channel; it is never delivered again). Runs under the channel lock.
   * An entry the watcher's ack already committed stays committed.
   */
  private async cancel(
    pending: CommitmentMeta,
    reason: string,
  ): Promise<CommitmentMeta | undefined> {
    const owner = {
      payTo: pending.payTo,
      network: pending.network,
      packageHash: pending.packageHash,
    };
    const after = await this.options.store.cancel(pending.seq, owner);
    if (after?.state === 'cancelled') {
      this.log.warn(
        { seq: pending.seq, period: pending.period, reason },
        'stored voucher cancelled',
      );
      await this.emit({
        key: pending.channelKey,
        kind: 'voucher_cancelled',
        data: { seq: pending.seq, reason, period: pending.period },
      });
    }
    return after;
  }

  /**
   * The answer for a cancelled entry: `period_mismatch` when the ledger shows
   * a later period (cancelled by the recheck, or worthless anyway), otherwise
   * the watcher's refusal.
   */
  private async whyCancelled(
    a: Authenticated,
    row: CommitmentMeta,
  ): Promise<{ reason: string; message: string }> {
    const state = await this.channelState(a);
    const period = state.ok ? state.value['period'] : undefined;
    return typeof period === 'number' && period > row.period
      ? {
          reason: R.period,
          message: `Channel period is ${period}; voucher ${row.seq} was cancelled`,
        }
      : { reason: R.refused, message: `The seller's watcher refused voucher ${row.seq}` };
  }

  /** The channel AA's state vars (hub). */
  private async channelState(a: Authenticated): Promise<Check<Record<string, unknown>>> {
    const client = this.options.clients.get(a.req.network.caip2);
    if (client === undefined) return fail('invalid_network', 'Network is not served');
    const vars = await hubCall(
      () => client.api.getAaStateVars({ address: a.voucher.aa_address }),
      this.hubTimeoutMs,
    );
    if (vars.kind !== 'ok') return fail(R.ledger, `state vars: ${vars.error}`);
    const state = parseStateVars(vars.value);
    if (state === undefined) return fail(R.ledger, 'state vars: malformed hub answer');
    return ok(state);
  }

  private async settleLocked(
    c: Authenticated & { readonly balance?: bigint },
    channelKey: string,
    network: Network,
  ): Promise<SettleResponse> {
    // Re-read under the lock: a concurrent settle may have stored or settled it.
    let commitment: CommitmentMeta | undefined = await this.options.store.commitmentMeta(
      c.packageHash,
    );
    if (commitment === undefined) {
      const appended = await this.append(c, channelKey, network);
      if ('success' in appended) return appended;
      commitment = appended;
    } else if (commitment.state === 'pending') {
      // A retry, maybe hours later: the period may have been closed meanwhile.
      const live = await this.recheck(c, commitment);
      if (!live.ok) {
        return live.unknown
          ? pendingSettle(network, commitment, c.payer, live.message)
          : { ...failure(network, live.reason, live.message), payer: c.payer };
      }
      commitment = live.value;
    }
    if (commitment.state === 'pending') {
      // Same package hash: the client's package IS the stored one (no decryption).
      const delivery = { ...commitment, packageJson: c.packageJson };
      const committed = await this.handToWatcher(c, delivery, channelKey, network);
      if ('success' in committed) return committed;
      commitment = committed;
    }
    if (commitment.state === 'cancelled') {
      const why = await this.whyCancelled(c, commitment);
      return { ...failure(network, why.reason, why.message), payer: c.payer };
    }
    return this.success(network, c.payer, commitment, c.balance);
  }

  /**
   * Appends the voucher to the channel journal as pending. The store enforces
   * committed + price, the period and one voucher in flight per channel; a
   * refusal reports the committed amount so an honest client can resync.
   */
  private async append(
    c: Authenticated,
    channelKey: string,
    network: Network,
  ): Promise<CommitmentRow | SettleResponse> {
    const appended = await this.options.store.appendPending({
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
    const commitment = appended.commitment;
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
    return commitment;
  }

  /**
   * Delivers a pending voucher to the seller's watcher and commits it on its
   * ack. Without the ack the voucher is stored here but not confirmed by the
   * watcher: the outcome is unknown to the client → settlement_pending (x402:
   * non-empty transaction), retried with the SAME voucher. Distinct from the
   * definite refusal `…_watcher_unavailable` at verification.
   */
  private async handToWatcher(
    c: Authenticated,
    pending: CommitmentRow,
    channelKey: string,
    network: Network,
  ): Promise<CommitmentMeta | SettleResponse> {
    const delivered = await this.options.gateway.deliver(pending, this.ackTimeoutMs);
    if (delivered.kind === 'refused') {
      this.log.warn({ seq: pending.seq, reason: delivered.reason }, 'watcher refused the voucher');
      await this.emit({
        key: channelKey,
        kind: 'voucher_cancelled',
        data: { seq: pending.seq, reason: delivered.reason },
      });
      return refusedSettle(network, c.payer, delivered.reason);
    }
    // The gateway committed the entry before reporting `acked`; re-read it so
    // success is only ever reported for an entry that IS committed.
    const commitment =
      delivered.kind === 'acked'
        ? await this.options.store.commitmentMeta(pending.packageHash)
        : undefined;
    if (commitment?.state !== 'committed') {
      this.log.warn({ seq: pending.seq }, 'watcher did not ack in time; voucher stays pending');
      await this.emit({ key: channelKey, kind: 'ack_timeout', data: { seq: pending.seq } });
      return pendingSettle(
        network,
        pending,
        c.payer,
        "Waiting for the seller's watcher to store this voucher; retry with the same voucher",
      );
    }
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
    return commitment;
  }

  private success(
    network: Network,
    payer: string,
    commitment: CommitmentMeta,
    balance?: bigint,
  ): SettleResponse {
    return {
      success: true,
      payer,
      network,
      transaction: '',
      amount: '',
      extra: {
        chargedAmount: commitment.paymentAmount.toString(),
        commitmentId: commitmentIdOf(network, commitment),
        channelState: {
          channelId: commitment.aa,
          period: commitment.period,
          ...(balance === undefined ? {} : { balance: balance.toString() }),
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
    if (!CHANNEL_BASE_AA_NETWORKS.has(req.network.caip2)) {
      return fail('invalid_network', 'Payment channels are not deployed on this network');
    }
    if (!this.options.allowedAssets.get(req.network.caip2)?.has(req.asset)) {
      return fail('invalid_batch_settlement_obyte_asset', 'Asset is not accepted');
    }
    const client = this.options.clients.get(req.network.caip2);
    if (client === undefined) return fail('invalid_network', 'Network is not served');

    // Voucher signature (bound to the network) and content. The AA profile:
    // only a package the channel AA's is_valid_signed_package accepts (no
    // extra fields such as `timestamp`, no `last_ball_unit`, version >= 2.0),
    // otherwise the seller could never close or fraud-proof with it.
    const pkg = payload.payload['signedPackage'];
    const verified = verifyVoucherPackage<unknown>(pkg, { network: req.network });
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
        packageJson,
        packageHash: packageHashOf(pkg),
      },
    };
  }

  /**
   * Checks that depend on time and live state, for a NEW voucher only: offer
   * validity, channel period, closing flag, confirmed deposit, the seller's
   * watcher. A stored voucher is decided by the watcher's ack instead
   * ({@link recheck}).
   */
  private async newVoucherChecks(c: Authenticated): Promise<Check<Checked>> {
    const { req, voucher: v } = c;
    if (req.extra.validUntil < this.now())
      return fail(R.quoteExpired, 'The payment offer has expired');
    const read = await this.channelState(c);
    if (!read.ok) return read;
    const state = read.value;
    if (state['period'] !== v.period)
      return fail(R.period, `Channel period is ${String(state['period'])}`);
    if (state['close_initiated_by'] !== undefined)
      return fail(R.closing, 'Channel is being closed');
    const rawBalance = state['balanceB'] ?? 0;
    if (!Number.isSafeInteger(rawBalance) || (rawBalance as number) < 0)
      return fail(R.ledger, 'state vars: balanceB is not a safe integer');
    const balance = BigInt(rawBalance as number);
    if (BigInt(v.amount_spent) > balance)
      return fail(R.balance, 'amount_spent exceeds the confirmed deposit');

    // The seller's watcher must be able to defend the channel (fail-closed).
    const health = this.options.gateway.health(req.payTo, req.network.caip2, v.aa_address);
    if (!health.ok && health.closing === true)
      return fail(R.closing, health.reason ?? 'The seller is closing this channel');
    if (!health.ok)
      return fail(R.watcher, health.reason ?? "The seller's watcher is not available");

    return ok({ ...c, balance });
  }

  private async channelParams(client: obyte.Client, aa: string): Promise<Check<ChannelParams>> {
    const cached = this.definitions.get(aa);
    if (cached !== undefined) return ok(cached);
    const res = await hubCall(() => client.api.getDefinition(aa), this.hubTimeoutMs);
    if (res.kind !== 'ok') return fail(R.ledger, `definition: ${res.error}`);
    if (res.value === null || res.value === undefined)
      // Our hub may not know a fresh AA yet (or lags after a restart).
      return fail(R.channel, 'Channel AA is not defined on the ledger', true);
    const parsed = parseChannelDefinition(aa, res.value);
    if (!parsed.ok) return fail(R.channel, parsed.message);
    this.definitions.set(aa, parsed.value);
    return ok(parsed.value);
  }

  /** The journal must never break a payment: failures are logged, not thrown. */
  private async emit(event: SettlementEvent): Promise<void> {
    try {
      await this.options.events?.(event);
    } catch (err) {
      this.log.error({ err, kind: event.kind }, 'cannot write payment event');
    }
  }

  private channelKey(c: Authenticated): string {
    return networkKey(getNetwork(c.req.network.caip2), 'aa', c.voucher.aa_address);
  }
}

function commitmentIdOf(network: Network, c: CommitmentMeta): string {
  return `${network}:${c.aa}:${c.period}:${c.amountSpent}`;
}

/** Outcome not known yet: non-empty `transaction` (x402), retry with the same voucher. */
function pendingSettle(
  network: Network,
  pending: CommitmentMeta,
  payer: string,
  message: string,
): SettleResponse {
  return {
    ...failure(network, 'settlement_pending', message),
    transaction: commitmentIdOf(network, pending),
    payer,
  };
}

function valid(payer: string, channel: string): VerifyResponse {
  return { isValid: true, payer, extra: { channel } };
}

function failure(network: Network, reason: string, message: string): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: '', network };
}

/** A voucher the seller's watcher refused (signed nack): definite, the client may drop it. */
function refusedSettle(network: Network, payer: string, reason: string): SettleResponse {
  return {
    success: false,
    errorReason: R.refused,
    errorMessage: `The seller's watcher refused this voucher: ${reason}`,
    transaction: '',
    network,
    payer,
  };
}
