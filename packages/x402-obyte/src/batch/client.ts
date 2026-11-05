import { randomBytes } from 'node:crypto';
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
  SettleResponse,
} from '@x402/core/types';
import {
  type ChannelParams,
  ObbyxError,
  type ObyteNetwork,
  channelAddress,
  channelDefinition,
  toSafeNumber,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import obyte from 'obyte';
import type { ReservingComposer } from '../coins/index.js';
import { hubCall } from '../hub/hub-call.js';
import { parseStateVars } from '../hub/schemas.js';
import type { ClientChannel, ClientChannelStore, PendingVoucher } from './client-store.js';
import {
  BATCH_REASONS,
  BATCH_SCHEME,
  type ParsedBatchRequirements,
  parseBatchRequirements,
} from './requirements.js';

/**
 * Buyer side of `batch-settlement` on Obyte (party B of an AA channel).
 * obyte.js is used directly: `compose.message` + `api.postJoint` for on-chain
 * actions, `utils.signMessage` for vouchers, `api.getAaStateVars` for state.
 */
export const MIN_DEPOSIT = 10_001n; // the AA treats ≤ 10000 bytes as a bounce-fee-only trigger
export const TRIGGER_FEE = 10_000;

export interface BatchClientOptions {
  readonly client: obyte.Client;
  readonly network: ObyteNetwork;
  readonly privateKey: Uint8Array;
  readonly store: ClientChannelStore;
  readonly logger: Logger;
  readonly hubTimeoutMs?: number;
  /** Refuse prices above this per call (atomic units per asset). */
  readonly maxAmount?: ReadonlyMap<string, bigint>;
  /** Reserves inputs for on-chain actions (open, deposit, close). */
  readonly composer?: ReservingComposer;
}

/** My address (party B) from the key, via obyte.js public API. */
export function addressOfKey(privateKey: Uint8Array, network: ObyteNetwork): string {
  const signed = obyte.utils.signMessage('obbyx', {
    privateKey,
    testnet: network.testnet,
  }) as unknown as {
    authors: { address: string }[];
  };
  const address = signed.authors[0]?.address;
  if (address === undefined) throw new ObbyxError('bad_key', 'Cannot derive address');
  return address;
}

async function broadcast(
  options: BatchClientOptions,
  messages: { app: string; payload: unknown }[],
): Promise<string> {
  const compose = () =>
    options.client.compose.message('multi', messages as never, {
      privateKey: options.privateKey,
      testnet: options.network.testnet,
    }) as unknown as Promise<Record<string, unknown>>;
  const unit = await (options.composer ? options.composer.compose(compose) : compose());
  const res = await hubCall(
    () => options.client.api.postJoint({ unit } as never),
    options.hubTimeoutMs ?? 15_000,
  );
  if (res.kind === 'hub_error')
    throw new ObbyxError('broadcast_rejected', `Hub rejected the unit: ${res.error}`);
  // ok or unknown: the unit hash identifies it either way; callers can check it later.
  return String(unit['unit']);
}

/**
 * Opens a channel to `payTo`: publishes the parameterized AA definition and the
 * first deposit in ONE unit (as aa-channels-lib does). The deposit is credited
 * by the AA once the unit is stable.
 */
export async function openChannel(
  options: BatchClientOptions,
  input: { payTo: string; deposit: bigint; timeout: number; asset?: string },
): Promise<{ aa: string; unit: string; params: ChannelParams }> {
  const asset = input.asset ?? 'base';
  if (asset !== 'base')
    throw new ObbyxError('unsupported', 'Only bytes channels are supported by the CLI for now');
  if (input.deposit < MIN_DEPOSIT)
    throw new ObbyxError('deposit_too_small', `Deposit must be at least ${MIN_DEPOSIT} bytes`);
  const params: ChannelParams = {
    addressA: input.payTo,
    addressB: addressOfKey(options.privateKey, options.network),
    asset,
    salt: randomBytes(12).toString('hex'),
    timeout: input.timeout,
  };
  const aa = channelAddress(params);
  const unit = await broadcast(options, [
    { app: 'definition', payload: { address: aa, definition: channelDefinition(params) } },
    {
      app: 'payment',
      payload: { outputs: [{ address: aa, amount: toSafeNumber(input.deposit) }] },
    },
  ]);
  options.store.add({
    network: options.network.caip2,
    aa,
    payTo: input.payTo,
    asset,
    timeout: input.timeout,
    salt: params.salt ?? '',
    openedUnit: unit,
  });
  moduleLogger(options.logger, 'x402.batch.client').info(
    { aa, unit, deposit: input.deposit.toString() },
    'channel opened',
  );
  return { aa, unit, params };
}

export function deposit(options: BatchClientOptions, aa: string, amount: bigint): Promise<string> {
  if (amount < MIN_DEPOSIT)
    throw new ObbyxError('deposit_too_small', `Deposit must be at least ${MIN_DEPOSIT} bytes`);
  return broadcast(options, [
    { app: 'payment', payload: { outputs: [{ address: aa, amount: toSafeNumber(amount) }] } },
  ]);
}

/**
 * The client (B) starts closing: declares what it spent. Pass the channel's
 * `maxSigned` (the highest voucher ever signed in this period), NOT just the
 * confirmed amount: declaring less than any voucher the seller holds lets it
 * take the whole channel with a fraud proof. The seller's watcher confirms at
 * once if the declaration is right.
 */
export function closeChannel(
  options: BatchClientOptions,
  aa: string,
  period: number,
  spent: bigint,
): Promise<string> {
  return broadcast(options, [
    { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_FEE }] } },
    { app: 'data', payload: { close: 1, period, transferredFromMe: toSafeNumber(spent) } },
  ]);
}

/** Confirms our own close after the dispute window. */
export function confirmClose(
  options: BatchClientOptions,
  aa: string,
  period: number,
): Promise<string> {
  return broadcast(options, [
    { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_FEE }] } },
    { app: 'data', payload: { confirm: 1, period } },
  ]);
}

export class BatchObyteClient implements SchemeNetworkClient {
  readonly scheme = BATCH_SCHEME;
  /**
   * The official x402 clients (`@x402/fetch`, `@x402/axios`) report the
   * seller's PAYMENT-RESPONSE here, so the voucher is confirmed or released
   * exactly as with `payingFetch`.
   */
  readonly schemeHooks: SchemeClientHooks = {
    onPaymentResponse: async (ctx) => {
      this.onSettled(ctx.requirements, ctx.settleResponse);
    },
  };
  private readonly log: Logger;

  constructor(private readonly options: BatchClientOptions) {
    this.log = moduleLogger(options.logger, 'x402.batch.client');
  }

  /** Is there a usable channel for these requirements? */
  hasChannel(req: PaymentRequirements): boolean {
    return this.options.store.find(req.network, req.payTo, req.asset) !== undefined;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2)
      throw new ObbyxError('invalid_x402_version', 'Only x402 v2 is supported');
    const parsed = parseBatchRequirements(requirements);
    if (!parsed.ok) throw new ObbyxError(parsed.reason, parsed.message);
    const req = parsed.value;
    const cap = this.options.maxAmount?.get(req.asset);
    if (cap !== undefined && req.amount > cap) {
      throw new ObbyxError('amount_over_limit', `Price ${req.amount} exceeds the limit ${cap}`);
    }
    const channel = this.channelFor(req);

    // Same operation retried: resend the same voucher (never sign a second one).
    if (channel.pending !== null) {
      if (channel.pending.binding === req.extra.binding)
        return { x402Version: 2, payload: { signedPackage: channel.pending.signedPackage } };
      throw new ObbyxError(
        'payment_pending',
        `A previous voucher on channel ${channel.aa} has an unknown outcome; retry that request first`,
      );
    }

    const { period, balance } = await this.ledgerState(channel);
    const committed = period > channel.period ? 0n : channel.committed;
    const amountSpent = committed + req.amount;
    if (amountSpent > balance) {
      throw new ObbyxError(
        'channel_exhausted',
        `Channel balance ${balance} is not enough; deposit more with: obbyx channel deposit ${channel.aa}`,
      );
    }
    return this.signVoucher(channel.aa, period, amountSpent, req);
  }

  /** Our open channel to this seller, with a dispute window the seller accepts. */
  private channelFor(req: ParsedBatchRequirements): ClientChannel {
    const channel = this.options.store.find(req.network.caip2, req.payTo, req.asset);
    if (channel === undefined) {
      throw new ObbyxError(
        'no_channel',
        `No channel to ${req.payTo}; open one with: obbyx channel open ${req.payTo}`,
      );
    }
    if (channel.timeout < req.extra.minTimeout) {
      throw new ObbyxError(
        'channel_timeout',
        `The seller requires a channel timeout ≥ ${req.extra.minTimeout} s`,
      );
    }
    return channel;
  }

  /**
   * The channel's current period and confirmed deposit, from the AA state.
   * A new period (the channel was closed and reopened) resets our local amount.
   */
  private async ledgerState(channel: ClientChannel): Promise<{ period: number; balance: bigint }> {
    const vars = await hubCall(
      () => this.options.client.api.getAaStateVars({ address: channel.aa }),
      this.options.hubTimeoutMs ?? 15_000,
    );
    if (vars.kind !== 'ok')
      throw new ObbyxError('ledger_unavailable', `Cannot read channel state: ${vars.error}`);
    const state = parseStateVars(vars.value);
    if (state === undefined)
      throw new ObbyxError('ledger_unavailable', 'Cannot read channel state: malformed hub answer');
    const period = typeof state['period'] === 'number' ? state['period'] : undefined;
    if (period === undefined)
      throw new ObbyxError(
        'channel_not_funded',
        'The channel has no confirmed deposit yet (wait until stable)',
      );
    if (state['close_initiated_by'] !== undefined)
      throw new ObbyxError('channel_closing', 'The channel is being closed');
    if (period > channel.period) this.options.store.newPeriod(channel.aa, period);
    const balance = BigInt(typeof state['balanceB'] === 'number' ? state['balanceB'] : 0);
    return { period, balance };
  }

  /** Signs the voucher and records it as THE pending one of the channel (one at a time). */
  private signVoucher(
    aa: string,
    period: number,
    amountSpent: bigint,
    req: ParsedBatchRequirements,
  ): PaymentPayloadResult {
    const message = {
      aa_address: aa,
      period,
      amount_spent: toSafeNumber(amountSpent),
      payment_amount: toSafeNumber(req.amount),
      binding: req.extra.binding,
    };
    const signedPackage = obyte.utils.signMessage(message, {
      privateKey: this.options.privateKey,
      testnet: this.options.network.testnet,
    }) as unknown as Record<string, unknown>;
    const pending: PendingVoucher = {
      binding: req.extra.binding,
      period,
      amountSpent: amountSpent.toString(),
      signedPackage,
    };
    if (!this.options.store.setPending(aa, pending)) {
      throw new ObbyxError('payment_pending', 'Another voucher on this channel is in flight');
    }
    this.log.info(
      { aa, period, amountSpent: amountSpent.toString(), binding: req.extra.binding },
      'voucher signed',
    );
    return { x402Version: 2, payload: { signedPackage } };
  }

  /** Updates local state from the seller's PAYMENT-RESPONSE (settlement result). */
  onSettled(requirements: PaymentRequirements, settle: SettleResponse | undefined): void {
    const channel = this.options.store.find(
      requirements.network,
      requirements.payTo,
      requirements.asset,
    );
    const pending = channel?.pending;
    if (channel === undefined || pending == null) return;
    // The answer concerns the voucher of THIS offer only: a replay of another
    // (earlier) operation must never confirm or drop the voucher now pending.
    if (requirements.extra['binding'] !== pending.binding) return;
    if (settle?.success === true) {
      this.options.store.confirm(channel.aa, pending.period, BigInt(pending.amountSpent));
      return;
    }
    const reason = settle?.errorReason;
    const charged = (settle?.extra as { chargedCumulativeAmount?: unknown } | undefined)
      ?.chargedCumulativeAmount;
    if (
      reason === BATCH_REASONS.cumulative &&
      typeof charged === 'string' &&
      /^\d+$/.test(charged)
    ) {
      this.resync(channel, pending, BigInt(charged));
    } else if (
      reason !== undefined &&
      reason !== 'settlement_pending' &&
      reason !== BATCH_REASONS.busy
    ) {
      // Definitely refused (incl. watcher_unavailable at verification): nothing was stored.
      this.options.store.dropPending(channel.aa);
    }
    // settlement_pending / busy / no answer: keep the voucher pending; retry the same operation.
  }

  /**
   * The seller says our committed amount differs. PAYMENT-RESPONSE is NOT
   * authenticated: never raise our committed amount to an arbitrary value (a
   * malicious seller could make us sign a voucher for the whole deposit).
   * Accept only exactly the voucher WE signed (it was committed earlier), or a
   * lower amount (signing less than before cannot hurt us).
   */
  private resync(channel: ClientChannel, pending: PendingVoucher, claimed: bigint): void {
    if (claimed === BigInt(pending.amountSpent)) {
      this.options.store.confirm(channel.aa, pending.period, claimed);
    } else if (pending.period === channel.period && claimed <= channel.committed) {
      this.options.store.dropPending(channel.aa, { period: pending.period, committed: claimed });
    } else {
      this.options.store.dropPending(channel.aa);
      this.log.error(
        { aa: channel.aa, claimed: claimed.toString(), local: channel.committed.toString() },
        'seller claimed a committed amount we never signed; refusing to resync',
      );
    }
  }
}
