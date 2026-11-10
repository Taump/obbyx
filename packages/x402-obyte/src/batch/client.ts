import { randomBytes } from 'node:crypto';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
  SettleResponse,
} from '@x402/core/types';
import {
  CHANNEL_BASE_AA,
  type ChannelParams,
  LEGACY_CHANNEL_BASE_AAS,
  ObbyxError,
  type ObyteNetwork,
  channelAddress,
  channelDefinition,
  parseAnyChannelDefinition,
  toSafeNumber,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import obyte from 'obyte';
import type { ReservingComposer } from '../coins/index.js';
import { hubCall } from '../hub/hub-call.js';
import { parseStateVars } from '../hub/schemas.js';
import type {
  ClientChannel,
  ClientChannelStore,
  CloseState,
  PendingVoucher,
} from './client-store.js';
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

export interface BatchObyteClientOptions {
  readonly client: obyte.Client;
  readonly network: ObyteNetwork;
  readonly privateKey: Uint8Array;
  readonly store: ClientChannelStore;
  readonly logger: Logger;
  readonly hubTimeoutMs?: number;
  /**
   * Refuse prices above this per call (atomic units per asset). REQUIRED to
   * pay: no voucher is signed for an asset without a limit here (a seller
   * could otherwise ask for the whole deposit in one call).
   */
  readonly maxAmount?: ReadonlyMap<string, bigint>;
  /** Reserves inputs for on-chain actions (open, deposit, close). */
  readonly composer?: ReservingComposer;
  /** Clock, seconds (tests). */
  readonly now?: () => number;
}

/** The AA state of a channel as far as the client cares. */
export interface OnChainChannelState {
  /** Undefined until the first deposit is credited. */
  readonly period: number | undefined;
  readonly balanceB: bigint;
  readonly closeInitiatedBy: 'A' | 'B' | undefined;
  readonly closeStartTs: number | undefined;
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

/**
 * Composes, then posts one unit. `beforePost` runs with the unit hash once it
 * is known and BEFORE anything is sent (persist what a crash must not lose).
 * A definite hub rejection throws `broadcast_rejected`; a lost answer is
 * `unknown` (the unit may have been accepted).
 */
async function broadcast(
  options: BatchObyteClientOptions,
  messages: { app: string; payload: unknown }[],
  beforePost?: (unit: string) => void,
): Promise<{ unit: string; outcome: 'ok' | 'unknown' }> {
  const compose = () =>
    options.client.compose.message('multi', messages as never, {
      privateKey: options.privateKey,
      testnet: options.network.testnet,
    }) as unknown as Promise<Record<string, unknown>>;
  const unit = await (options.composer ? options.composer.compose(compose) : compose());
  const hash = String(unit['unit']);
  beforePost?.(hash);
  const res = await hubCall(
    () => options.client.api.postJoint({ unit } as never),
    options.hubTimeoutMs ?? 15_000,
  );
  if (res.kind === 'hub_error')
    throw new ObbyxError('broadcast_rejected', `Hub rejected the unit: ${res.error}`, {
      details: { unit: hash },
    });
  return { unit: hash, outcome: res.kind === 'ok' ? 'ok' : 'unknown' };
}

/** Reads the channel's AA state (period, B's deposit, close in progress). */
export async function readChannelState(
  options: Pick<BatchObyteClientOptions, 'client' | 'hubTimeoutMs'>,
  aa: string,
): Promise<OnChainChannelState> {
  const vars = await hubCall(
    () => options.client.api.getAaStateVars({ address: aa }),
    options.hubTimeoutMs ?? 15_000,
  );
  if (vars.kind !== 'ok')
    throw new ObbyxError('ledger_unavailable', `Cannot read channel state: ${vars.error}`);
  const state = parseStateVars(vars.value);
  if (state === undefined)
    throw new ObbyxError('ledger_unavailable', 'Cannot read channel state: malformed hub answer');
  const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
  const by = state['close_initiated_by'];
  return {
    period: num(state['period']),
    balanceB: BigInt(num(state['balanceB']) ?? 0),
    closeInitiatedBy: by === 'A' || by === 'B' ? by : undefined,
    closeStartTs: num(state['close_start_ts']),
  };
}

/**
 * Opens a channel to `payTo`: publishes the parameterized AA definition and the
 * first deposit in ONE unit (as aa-channels-lib does). The deposit is credited
 * by the AA once the unit is stable.
 *
 * The channel is recorded BEFORE the unit is posted (its salt is random: a
 * crash after posting must not orphan a funded channel); it is forgotten only
 * when the hub definitely rejects the unit.
 */
export async function openChannel(
  options: BatchObyteClientOptions,
  input: { payTo: string; deposit: bigint; timeout: number; asset?: string },
): Promise<{ aa: string; unit: string; params: ChannelParams; outcome: 'ok' | 'unknown' }> {
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
  const aa = channelAddress(params, CHANNEL_BASE_AA);
  let result: { unit: string; outcome: 'ok' | 'unknown' };
  try {
    result = await broadcast(
      options,
      [
        {
          app: 'definition',
          payload: { address: aa, definition: channelDefinition(params, CHANNEL_BASE_AA) },
        },
        {
          app: 'payment',
          payload: { outputs: [{ address: aa, amount: toSafeNumber(input.deposit) }] },
        },
      ],
      (unit) =>
        options.store.add({
          network: options.network.caip2,
          aa,
          payTo: input.payTo,
          asset,
          timeout: input.timeout,
          salt: params.salt ?? '',
          openedUnit: unit,
        }),
    );
  } catch (err) {
    if (err instanceof ObbyxError && err.code === 'broadcast_rejected')
      options.store.removeUnopened(aa);
    throw err;
  }
  moduleLogger(options.logger, 'x402.batch.client').info(
    { aa, unit: result.unit, outcome: result.outcome, deposit: input.deposit.toString() },
    'channel opened',
  );
  return { aa, unit: result.unit, params, outcome: result.outcome };
}

/**
 * Tops up a channel. Refused for a channel not in the store or on a legacy
 * base AA, and while a close is pending (locally started or on-chain): the
 * AA would bounce the deposit minus a 10000-byte fee.
 */
export async function deposit(
  options: BatchObyteClientOptions,
  aa: string,
  amount: bigint,
): Promise<string> {
  if (amount < MIN_DEPOSIT)
    throw new ObbyxError('deposit_too_small', `Deposit must be at least ${MIN_DEPOSIT} bytes`);
  const channel = options.store.get(aa);
  if (channel === undefined) throw new ObbyxError('no_channel', `Unknown channel ${aa}`);
  if (channel.legacy)
    throw new ObbyxError(
      'legacy_channel',
      `Channel ${aa} is on a retired base AA; close it (obbyx channel close ${aa}) and open a new one`,
    );
  const state = await readChannelState(options, aa);
  if (state.closeInitiatedBy !== undefined)
    throw new ObbyxError(
      'channel_closing',
      `Channel ${aa} is being closed (by the ${state.closeInitiatedBy === 'A' ? 'seller' : 'buyer'}); ` +
        'a deposit now would be refunded minus a 10000-byte fee. Finish the close, then deposit again.',
    );
  if (closingLocally(options, aa, state))
    throw new ObbyxError(
      'channel_closing',
      `You started closing channel ${aa}; a deposit now would be refunded minus a 10000-byte fee`,
    );
  const { unit } = await broadcast(options, [
    { app: 'payment', payload: { outputs: [{ address: aa, amount: toSafeNumber(amount) }] } },
  ]);
  return unit;
}

export type CloseResult =
  | {
      readonly kind: 'requested';
      readonly unit: string;
      readonly period: number;
      readonly declared: bigint;
      /** `ok`: the hub accepted the unit; `unknown`: no answer (it may have been accepted). */
      readonly outcome: 'ok' | 'unknown';
      /** State of an earlier close of this period, if any (`posted`/`unknown`: it may land first). */
      readonly previous: CloseState | null;
    }
  | {
      /**
       * We already sent a close for this period (same declaration), but the
       * chain shows no close pending: nothing is resent unless `resend` is passed or the
       * declaration is raised (a duplicate would only bounce, losing its fee).
       */
      readonly kind: 'sent_earlier';
      readonly period: number;
      readonly declared: bigint;
      /** `posted`: the hub accepted it; `unknown`: no answer. */
      readonly state: 'posted' | 'unknown';
    }
  | {
      /** A close is already pending on-chain: never send a second one. */
      readonly kind: 'already_closing';
      readonly by: 'A' | 'B';
      readonly period: number;
      /** When WE may confirm (seconds): at once for the seller's close, after the window for ours. */
      readonly confirmableAt: number;
    };

/**
 * The client (B) starts closing the channel's CURRENT on-chain period.
 *
 * The declaration is not the caller's: it is the highest amount ever signed
 * in that period, read and frozen (no more vouchers) in one store
 * transaction BEFORE the close is broadcast. Declaring less than any voucher
 * the seller holds lets it take the whole channel with a fraud proof. A
 * pending voucher is included (closing with one is safe). The seller's
 * watcher confirms at once if the declaration is right.
 *
 * `declare` raises the declaration (never below what we know we signed);
 * `force` accepts an uncertain amount on a channel migrated from an old
 * version or recovered from the chain (see
 * {@link ClientChannel.uncertainty}); `resend` sends again a close
 * that was sent earlier but never showed up on-chain.
 *
 * A retry after a close that was never posted, or that the hub definitely
 * rejected, broadcasts again by itself (same or higher declaration). After
 * one that was posted (or whose outcome is unknown), a retry sends again
 * only with `resend` or a higher `declare`. Signing stays stopped whatever
 * happens to the broadcast: an unknown outcome may still land.
 */
export async function closeChannel(
  options: BatchObyteClientOptions,
  aa: string,
  opts: { readonly declare?: bigint; readonly force?: boolean; readonly resend?: boolean } = {},
): Promise<CloseResult> {
  const channel = options.store.get(aa);
  if (channel === undefined) throw new ObbyxError('no_channel', `Unknown channel ${aa}`);
  const state = await readChannelState(options, aa);
  if (state.period === undefined)
    throw new ObbyxError(
      'channel_not_funded',
      'The channel has no credited deposit yet (nothing to close; wait until the open unit is stable)',
    );
  const pendingClose = alreadyClosing(options, channel, state);
  if (pendingClose !== undefined) return pendingClose;
  const period = state.period;
  const { declared, previous, raised } = options.store.beginClose(aa, period, opts);
  if ((previous === 'posted' || previous === 'unknown') && !raised && opts.resend !== true)
    return { kind: 'sent_earlier', period, declared, state: previous };
  let result: { unit: string; outcome: 'ok' | 'unknown' };
  try {
    result = await broadcast(
      options,
      [
        { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_FEE }] } },
        {
          app: 'data',
          payload: { close: 1, period, transferredFromMe: toSafeNumber(declared) },
        },
      ],
      // From here the unit may reach the network: its outcome is unknown until
      // answered. Only if the recorded declaration is still ours: another
      // process may have replaced a `prepared` one meanwhile.
      () => {
        if (!options.store.closeSent(aa, period, declared))
          throw new ObbyxError(
            'close_superseded',
            `Another close of period ${period} was started meanwhile; nothing was sent. ` +
              `Check: obbyx channel status ${aa}`,
          );
      },
    );
  } catch (err) {
    // Definitely not accepted: the next close sends again. Signing stays
    // stopped: an earlier attempt may still land.
    if (err instanceof ObbyxError && err.code === 'broadcast_rejected')
      options.store.setCloseState(aa, period, 'rejected');
    throw err;
  }
  if (result.outcome === 'ok') options.store.setCloseState(aa, period, 'posted');
  moduleLogger(options.logger, 'x402.batch.client').info(
    {
      aa,
      unit: result.unit,
      period,
      declared: declared.toString(),
      previous,
      outcome: result.outcome,
    },
    'channel close requested',
  );
  return {
    kind: 'requested',
    unit: result.unit,
    period,
    declared,
    outcome: result.outcome,
    previous,
  };
}

function alreadyClosing(
  options: BatchObyteClientOptions,
  channel: ClientChannel,
  state: OnChainChannelState,
): Extract<CloseResult, { kind: 'already_closing' }> | undefined {
  if (state.closeInitiatedBy === undefined || state.period === undefined) return undefined;
  options.store.markClosing(channel.aa, state.period);
  return {
    kind: 'already_closing',
    by: state.closeInitiatedBy,
    period: state.period,
    confirmableAt: state.closeInitiatedBy === 'A' ? 0 : (state.closeStartTs ?? 0) + channel.timeout,
  };
}

/**
 * Confirms the pending close of the channel's on-chain period: at once when
 * the seller (A) started it, after `close_start_ts + timeout` when we did.
 */
export async function confirmClose(
  options: BatchObyteClientOptions,
  aa: string,
): Promise<{ unit: string; period: number; by: 'A' | 'B' }> {
  const channel = options.store.get(aa);
  if (channel === undefined) throw new ObbyxError('no_channel', `Unknown channel ${aa}`);
  const state = await readChannelState(options, aa);
  const pendingClose = alreadyClosing(options, channel, state);
  if (pendingClose === undefined)
    throw new ObbyxError(
      'not_closing',
      `No close is pending on-chain for ${aa}` +
        (channel.lastClose === null
          ? `; start one with: obbyx channel close ${aa}`
          : ' yet (your close unit is not stable yet, or the channel is already closed); check: obbyx channel status ' +
            aa),
    );
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (now < pendingClose.confirmableAt)
    throw new ObbyxError(
      'too_early',
      `You started this close: you can confirm it after the ${channel.timeout} s dispute window, ` +
        `in ${pendingClose.confirmableAt - now} s (at ${new Date(pendingClose.confirmableAt * 1000).toISOString()}). ` +
        'The seller can confirm it earlier.',
      { details: { confirmableAt: pendingClose.confirmableAt } },
    );
  const { unit } = await broadcast(options, [
    { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_FEE }] } },
    { app: 'data', payload: { confirm: 1, period: pendingClose.period } },
  ]);
  return { unit, period: pendingClose.period, by: pendingClose.by };
}

/**
 * Finds channels where we are party B on the current and legacy base AAs
 * (hub `light/get_aas_by_base_aas`) and records the ones the store is
 * missing (e.g. after a crash between posting the open unit and recording
 * it). Returns the recorded ones.
 *
 * What was signed on a recovered channel is unknown (another database, or
 * a lost one, may have signed vouchers): every period is uncertain, so
 * closing it needs an explicit `declare` (or `force`).
 */
export async function recoverChannels(options: BatchObyteClientOptions): Promise<ClientChannel[]> {
  const me = addressOfKey(options.privateKey, options.network);
  const res = await hubCall(
    () =>
      options.client.api.getAasByBaseAas({
        base_aas: [CHANNEL_BASE_AA, ...LEGACY_CHANNEL_BASE_AAS],
        params: { addressB: me },
      }),
    options.hubTimeoutMs ?? 30_000,
  );
  if (res.kind !== 'ok')
    throw new ObbyxError('ledger_unavailable', `Cannot list channels: ${res.error}`);
  const found: ClientChannel[] = [];
  for (const entry of Array.isArray(res.value) ? res.value : []) {
    const address: unknown = entry.address;
    if (typeof address !== 'string' || options.store.get(address) !== undefined) continue;
    const parsed = parseAnyChannelDefinition(address, entry.definition);
    if (!parsed.ok || parsed.value.params.addressB !== me) continue;
    const { params, baseAa } = parsed.value;
    options.store.add({
      network: options.network.caip2,
      aa: address,
      payTo: params.addressA,
      asset: params.asset,
      timeout: params.timeout,
      salt: params.salt ?? '',
      baseAa,
      openedUnit: typeof entry.unit === 'string' ? entry.unit : null,
      recovered: true,
    });
    const added = options.store.get(address);
    if (added !== undefined) found.push(added);
  }
  return found;
}

/**
 * We started closing the on-chain period (the close is over once the chain
 * shows a later period). A close recorded for another period (e.g. one a
 * lying hub reported) does not block this one.
 */
function closingLocally(
  options: BatchObyteClientOptions,
  aa: string,
  state: OnChainChannelState,
): boolean {
  return state.period !== undefined && options.store.closeState(aa, state.period) !== undefined;
}

/** Channel errors after which nothing was signed and the next channel may be tried. */
const SKIP_CHANNEL = new Set(['channel_not_funded', 'channel_closing']);

export class BatchObyteClient implements SchemeNetworkClient {
  readonly scheme = BATCH_SCHEME;
  /**
   * The official x402 clients (`@x402/fetch`, `@x402/axios`) report the
   * seller's PAYMENT-RESPONSE here, so the voucher is confirmed or released
   * exactly as with `payingFetch`.
   */
  readonly schemeHooks: SchemeClientHooks = {
    // The payload really sent (with `resource` and `extensions`): kept as the retry header.
    onAfterPaymentCreation: async (ctx) => {
      this.rememberPaymentHeader(
        ctx.paymentPayload.accepted,
        encodePaymentSignatureHeader(ctx.paymentPayload),
      );
    },
    onPaymentResponse: async (ctx) => {
      this.onSettled(ctx.requirements, ctx.settleResponse);
    },
  };
  private readonly log: Logger;

  constructor(private readonly options: BatchObyteClientOptions) {
    this.log = moduleLogger(options.logger, 'x402.batch.client');
  }

  /** Is there a usable channel (current base AA) for these requirements? */
  hasChannel(req: PaymentRequirements): boolean {
    return (
      req.extra['baseAa'] === CHANNEL_BASE_AA &&
      this.options.store.find(req.network, req.payTo, req.asset) !== undefined
    );
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
    if (cap === undefined)
      throw new ObbyxError(
        'no_spending_limit',
        `No per-call limit (maxAmount) is configured for asset ${req.asset}; refusing to sign`,
      );
    if (req.amount > cap) {
      throw new ObbyxError('amount_over_limit', `Price ${req.amount} exceeds the limit ${cap}`);
    }
    let lastError: ObbyxError | undefined;
    for (const candidate of this.channelsFor(req)) {
      let state: { period: number; balance: bigint };
      try {
        // The ledger first: a new period voids (drops) an old pending voucher.
        state = await this.ledgerState(candidate);
      } catch (err) {
        if (err instanceof ObbyxError && SKIP_CHANNEL.has(err.code)) {
          lastError = err;
          continue;
        }
        throw err;
      }
      const channel = this.options.store.get(candidate.aa) ?? candidate;
      // Same operation retried: resend the same voucher (never sign a second one).
      if (channel.pending !== null) {
        if (channel.pending.binding === req.extra.binding)
          return { x402Version: 2, payload: { signedPackage: channel.pending.signedPackage } };
        // Another operation's voucher is pending here: a new one may use the next channel.
        lastError = new ObbyxError(
          'payment_pending',
          `A previous voucher on channel ${channel.aa} has an unknown outcome; retry that request first` +
            ' (its payment header: obbyx channel status ' +
            channel.aa +
            '), or close the channel',
          {
            details: {
              aa: channel.aa,
              ...(channel.pending.paymentHeader === undefined
                ? {}
                : { paymentHeader: channel.pending.paymentHeader }),
            },
          },
        );
        continue;
      }
      const amountSpent = channel.committed + req.amount;
      if (amountSpent > state.balance) {
        throw new ObbyxError(
          'channel_exhausted',
          `Channel balance ${state.balance} is not enough; deposit more with: obbyx channel deposit ${channel.aa}`,
        );
      }
      return this.signVoucher(channel.aa, state.period, amountSpent, req, requirements);
    }
    throw lastError ?? new ObbyxError('no_channel', 'No usable channel');
  }

  /**
   * Remembers the full PAYMENT-SIGNATURE header really sent with the pending
   * voucher of `requirements`, so the operation can be retried after a crash.
   */
  rememberPaymentHeader(requirements: PaymentRequirements, header: string): void {
    if (requirements.scheme !== BATCH_SCHEME) return;
    const channel = this.pendingFor(requirements);
    if (channel?.pending != null)
      this.options.store.attachPaymentHeader(channel.aa, channel.pending.binding, header);
  }

  /** The channel holding the pending voucher of this offer (its binding), if any. */
  private pendingFor(requirements: PaymentRequirements): ClientChannel | undefined {
    const binding = requirements.extra['binding'];
    return this.options.store
      .candidates(requirements.network, requirements.payTo, requirements.asset)
      .find((c) => c.pending !== null && c.pending.binding === binding);
  }

  /**
   * Our channels to this seller with a dispute window the seller accepts,
   * best first; for a retried operation, only the channel holding its
   * pending voucher (a second voucher is never signed elsewhere).
   */
  private channelsFor(req: ParsedBatchRequirements): ClientChannel[] {
    // `req.extra.baseAa` is the current one (parseBatchRequirements).
    const all = this.options.store.candidates(req.network.caip2, req.payTo, req.asset);
    const retried = all.find((c) => c.pending?.binding === req.extra.binding);
    if (retried !== undefined) return [retried];
    if (all.length === 0) {
      throw new ObbyxError(
        'no_channel',
        `No channel to ${req.payTo}; open one with: obbyx channel open ${req.payTo}`,
      );
    }
    const usable = all.filter((c) => c.timeout >= req.extra.minTimeout);
    if (usable.length === 0) {
      throw new ObbyxError(
        'channel_timeout',
        `The seller requires a channel timeout ≥ ${req.extra.minTimeout} s`,
      );
    }
    return usable;
  }

  /**
   * The channel's current period and confirmed deposit, from the AA state.
   * A new period (the channel was closed and reopened) resets our local
   * amount and voids a pending voucher of the old period.
   */
  private async ledgerState(channel: ClientChannel): Promise<{ period: number; balance: bigint }> {
    const state = await readChannelState(this.options, channel.aa);
    if (state.period === undefined)
      throw new ObbyxError(
        'channel_not_funded',
        'The channel has no confirmed deposit yet (wait until stable)',
      );
    if (!channel.funded) this.options.store.markFunded(channel.aa);
    if (state.closeInitiatedBy !== undefined) {
      this.options.store.markClosing(channel.aa, state.period);
      throw new ObbyxError('channel_closing', 'The channel is being closed');
    }
    if (closingLocally(this.options, channel.aa, state))
      throw new ObbyxError('channel_closing', 'You started closing this channel');
    if (state.period < channel.period)
      throw new ObbyxError(
        'ledger_inconsistent',
        `The hub reports period ${state.period}, older than the known period ${channel.period}`,
      );
    this.options.store.newPeriod(channel.aa, state.period);
    return { period: state.period, balance: state.balanceB };
  }

  /** Signs the voucher and records it as THE pending one of the channel (one at a time). */
  private signVoucher(
    aa: string,
    period: number,
    amountSpent: bigint,
    req: ParsedBatchRequirements,
    requirements: PaymentRequirements,
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
    // Compare-and-set: refused if another voucher is pending, the period
    // moved, or a close was started meanwhile (by any process). The voucher
    // is then discarded unsent.
    const recorded = this.options.store.setPending(aa, {
      binding: req.extra.binding,
      period,
      amountSpent: amountSpent.toString(),
      signedPackage,
      // Retry header, replaced by the caller's own (with `resource` and
      // `extensions`) once known: rememberPaymentHeader / onAfterPaymentCreation.
      paymentHeader: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: requirements,
        payload: { signedPackage },
      }),
    });
    if (!recorded) {
      if (this.options.store.closeState(aa, period) !== undefined)
        throw new ObbyxError('channel_closing', 'You started closing this channel');
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
    // The answer concerns the voucher of THIS offer only: a replay of another
    // (earlier) operation must never confirm or drop the voucher now pending.
    const channel = this.pendingFor(requirements);
    const pending = channel?.pending;
    if (channel === undefined || pending == null) return;
    if (settle?.success === true) {
      this.options.store.confirm(channel.aa, pending, BigInt(pending.amountSpent));
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
      this.options.store.dropPending(channel.aa, pending);
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
      this.options.store.confirm(channel.aa, pending, claimed);
    } else if (pending.period === channel.period && claimed <= channel.committed) {
      this.options.store.dropPending(channel.aa, pending, claimed);
    } else {
      this.options.store.dropPending(channel.aa, pending);
      this.log.error(
        { aa: channel.aa, claimed: claimed.toString(), local: channel.committed.toString() },
        'seller claimed a committed amount we never signed; refusing to resync',
      );
    }
  }
}
