import type obyte from 'obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import { KeyedQueue, hubCall, parseStateVars } from '@obbyx/x402-obyte';
import { type ClosePolicy, channelState, decide } from './decide.js';
import type { ActionKind, ActionRow, WatcherStore } from '../storage/store.js';

/**
 * Defends the seller's channels: periodically reads each channel's AA state,
 * decides (decide.ts) and sends AA triggers from the seller's address with
 * obyte.js (`client.compose.message` + `api.postJoint`). Each trigger carries
 * the 10 000-byte bounce fee the AA requires.
 *
 * Duplicate protection: one action row per (aa, period, kind). A sent trigger
 * is not repeated before `resendAfterSeconds`, and never once the AA state
 * shows it took effect (period advanced / close registered).
 */
export const TRIGGER_AMOUNT = 10_000;

/** A seller close is sent this long after it was announced (> heartbeat + ack timeout). */
export const DEFAULT_CLOSE_ANNOUNCE_SECONDS = 30;
/** A trigger without visible effect is re-sent after this long. */
export const DEFAULT_RESEND_AFTER_SECONDS = 600;

export interface DefenderOptions {
  readonly client: obyte.Client;
  readonly store: WatcherStore;
  readonly logger: Logger;
  readonly privateKey: Uint8Array;
  readonly testnet: boolean;
  readonly policy: ClosePolicy;
  readonly hubTimeoutMs?: number;
  readonly resendAfterSeconds?: number;
  /**
   * A seller close is broadcast only this long after it was announced to the
   * facilitator (default 30 s > heartbeat + ack timeout): vouchers accepted
   * before the announcement are stored and acked first, and none is accepted
   * after it, so the close carries the final best voucher.
   */
  readonly closeAnnounceSeconds?: number;
  /** Tells the facilitator about channels being closed (the link's heartbeat). */
  readonly announce?: () => Promise<void>;
  readonly now?: () => number;
}

export class Defender {
  private readonly log: Logger;
  private readonly now: () => number;
  private running: Promise<void> | undefined;
  /**
   * A push and the poll pass never defend one channel at the same time: each
   * run reads the stored actions again, so the second sees the trigger the
   * first one sent and does not send it twice.
   */
  private readonly channels = new KeyedQueue();

  constructor(private readonly options: DefenderOptions) {
    this.log = moduleLogger(options.logger, 'watcher.defender');
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** One pass over all channels; concurrent calls share the running pass. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  /** Defends one channel right away (e.g. on a `light/aa_response` push). */
  async defendNow(aa: string): Promise<void> {
    const channel = await this.options.store.channel(aa);
    if (channel === undefined) return;
    try {
      await this.channels.run(aa, () => this.defend(aa, channel.timeout));
    } catch (err) {
      this.log.error({ err, aa }, 'defending a channel failed');
    }
  }

  private async pass(): Promise<void> {
    for (const channel of await this.options.store.channels()) {
      try {
        await this.channels.run(channel.aa, () => this.defend(channel.aa, channel.timeout));
      } catch (err) {
        this.log.error({ err, aa: channel.aa }, 'defending a channel failed');
      }
    }
  }

  private async defend(aa: string, timeout: number): Promise<void> {
    const t = this.options.hubTimeoutMs ?? 15_000;
    const vars = await hubCall(() => this.options.client.api.getAaStateVars({ address: aa }), t);
    if (vars.kind !== 'ok') {
      this.log.warn({ aa, error: vars.error }, 'cannot read channel state; will retry');
      return;
    }
    const stateVars = parseStateVars(vars.value);
    if (stateVars === undefined) {
      this.log.warn({ aa }, 'malformed channel state from the hub; will retry');
      return;
    }
    const state = channelState(stateVars);
    // A finished close (the channel moved to a new period) no longer blocks vouchers.
    if (
      state.period !== undefined &&
      (await this.options.store.finishCloses(aa, state.period)) > 0
    ) {
      await this.options.announce?.().catch(() => undefined);
    }
    const best =
      state.period === undefined ? undefined : await this.options.store.best(aa, state.period);
    const decision = decide({ state, best, timeout, now: this.now(), policy: this.options.policy });
    const log = this.log.child({ aa, period: state.period });
    if (decision.action === 'none') {
      log.trace({ why: decision.why }, 'no action');
      return;
    }
    if (decision.action === 'alert') {
      log.error({ why: decision.why }, 'INVARIANT ALERT');
      return;
    }

    const previous = await this.options.store.action(aa, decision.period, decision.action);
    if ((await this.readiness(aa, decision, previous, log)) !== 'send') return;

    const data: Record<string, unknown> =
      decision.action === 'confirm'
        ? { confirm: 1, period: decision.period }
        : decision.action === 'close'
          ? {
              close: 1,
              period: decision.period,
              transferredFromMe: 0,
              sentByPeer: JSON.parse(best?.packageJson ?? 'null') as unknown,
            }
          : { fraud_proof: 1, sentByPeer: JSON.parse(best?.packageJson ?? 'null') as unknown };
    log.info({ action: decision.action, why: decision.why }, 'sending channel trigger');
    await this.send(aa, decision.period, decision.action, data);
  }

  /**
   * Whether a trigger may be sent now:
   * - a seller close is first ANNOUNCED (the facilitator then refuses new
   *   vouchers for the channel) and sent `closeAnnounceSeconds` later, so it
   *   carries the final best voucher;
   * - a trigger already sent is not repeated within `resendAfterSeconds`.
   */
  private async readiness(
    aa: string,
    decision: { action: ActionKind; period: number },
    previous: ActionRow | undefined,
    log: Logger,
  ): Promise<'send' | 'wait'> {
    const now = this.now();
    if (decision.action === 'close' && (previous === undefined || previous.status === 'failed')) {
      await this.options.store.recordAction({
        aa,
        period: decision.period,
        kind: 'close',
        unit: null,
        status: 'announced',
      });
      await this.options.announce?.().catch((err: unknown) => log.warn({ err }, 'announce failed'));
      log.info('close announced; it is sent after the vouchers already in flight');
      return 'wait';
    }
    const announceFor = this.options.closeAnnounceSeconds ?? DEFAULT_CLOSE_ANNOUNCE_SECONDS;
    if (previous?.status === 'announced' && now - previous.updatedAt < announceFor) return 'wait';
    const resendAfter = this.options.resendAfterSeconds ?? DEFAULT_RESEND_AFTER_SECONDS;
    if (previous?.status === 'sent' && now - previous.updatedAt < resendAfter) {
      log.debug(
        { action: decision.action, unit: previous.unit },
        'trigger already sent; waiting for it to take effect',
      );
      return 'wait';
    }
    return 'send';
  }

  private async send(
    aa: string,
    period: number,
    kind: ActionKind,
    data: Record<string, unknown>,
  ): Promise<void> {
    const t = this.options.hubTimeoutMs ?? 15_000;
    let unit: Record<string, unknown>;
    try {
      unit = (await this.options.client.compose.message(
        'multi',
        [
          { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_AMOUNT }] } },
          { app: 'data', payload: data },
        ] as never,
        { privateKey: this.options.privateKey, testnet: this.options.testnet },
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      await this.options.store.recordAction({
        aa,
        period,
        kind,
        unit: null,
        status: 'failed',
        error: String(err),
      });
      this.log.error({ err, aa, kind }, 'cannot compose trigger (enough bytes?)');
      return;
    }
    const hash = String(unit['unit']);
    // Record before broadcast: an unknown outcome still prevents a duplicate.
    await this.options.store.recordAction({ aa, period, kind, unit: hash, status: 'sent' });
    const posted = await hubCall(() => this.options.client.api.postJoint({ unit } as never), t);
    if (posted.kind === 'hub_error') {
      await this.options.store.recordAction({
        aa,
        period,
        kind,
        unit: hash,
        status: 'failed',
        error: posted.error,
      });
      this.log.error({ aa, kind, hubError: posted.error }, 'hub rejected the trigger');
      return;
    }
    this.log.info({ aa, kind, unit: hash, outcome: posted.kind }, 'trigger broadcast');
  }
}
