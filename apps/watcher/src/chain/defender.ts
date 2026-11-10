import type obyte from 'obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import { KeyedQueue, hubCall, parseStateVars } from '@obbyx/x402-obyte';
import {
  type BestVoucher,
  type ChannelState,
  type ClosePolicy,
  channelState,
  decide,
} from './decide.js';
import type { ActionKind, ActionRow, WatcherStore } from '../storage/store.js';

/**
 * Defends the seller's channels: periodically reads each channel's AA state,
 * decides (decide.ts) and sends AA triggers from the seller's address with
 * obyte.js (`client.compose.message` + `api.postJoint`). Each trigger carries
 * the 10 000-byte bounce fee the AA requires.
 *
 * Duplicate protection: one action row per (aa, period, kind), see
 * {@link Defender.plan}. Never re-sent once the AA state shows it took effect.
 *
 * Race with voucher storage: the decision is re-taken, and the confirm/close
 * recorded, in ONE database transaction with the read of the best voucher
 * (`store.atomically`); `saveVoucher` refuses vouchers of a period with such
 * a row. A voucher is therefore either seen by the decision or never acked.
 *
 * Channels on a legacy base AA are defended like current ones: the defender
 * works from the stored channel rows and never re-parses their definition.
 */
export const TRIGGER_AMOUNT = 10_000;

/** A seller close is sent this long after it was announced (> heartbeat + ack timeout). */
export const DEFAULT_CLOSE_ANNOUNCE_SECONDS = 30;
/**
 * A sent unit the hub does not know counts as lost only this long after it
 * was sent: a timed-out post may still land (re-composing at once could
 * spend the same coins in a conflicting unit).
 */
export const LOST_AFTER_SECONDS = 120;
/** Re-send delay after a failure (bounce, hub refusal): doubled per attempt from MIN, capped at MAX. */
export const MIN_RESEND_SECONDS = 30;
export const MAX_RESEND_SECONDS = 1800;
/** Units that could have landed per action row before giving up (ALERT). */
export const MAX_ATTEMPTS = 6;
/** ALERT when a sent unit the hub knows has no AA response after this long. */
const STUCK_ALERT_SECONDS = 600;
/** ALERT when the hub's last stable unit is older than this. */
const HUB_MAX_LAG_SECONDS = 900;
/** ALERT when a client close is first seen with less than this share of its window left. */
const LATE_CLOSE_FRACTION = 0.25;
/** AA bounce message: the voucher carried fails `is_valid_signed_package`. */
const INVALID_PEER_SIGNATURE = 'invalid signature by peer';

/** Delay before re-sending a failed trigger, after `attempts` units. */
export function bounceBackoff(attempts: number): number {
  const n = Math.min(Math.max(0, attempts - 1), 20);
  return Math.min(MAX_RESEND_SECONDS, MIN_RESEND_SECONDS * 2 ** n);
}

export interface DefenderOptions {
  readonly client: obyte.Client;
  readonly store: WatcherStore;
  readonly logger: Logger;
  readonly privateKey: Uint8Array;
  readonly testnet: boolean;
  readonly policy: ClosePolicy;
  readonly hubTimeoutMs?: number;
  /** Timeout of composing one trigger (default 60 s; a hung compose blocks every channel). */
  readonly composeTimeoutMs?: number;
  /**
   * A seller close is broadcast only this long after it was announced to the
   * facilitator (default 30 s > heartbeat + ack timeout), so it carries the
   * final best voucher.
   */
  readonly closeAnnounceSeconds?: number;
  /** Tells the facilitator about channels being closed (the link's heartbeat). */
  readonly announce?: () => Promise<void>;
  readonly now?: () => number;
}

/**
 * What the hub knows of a sent unit (`rejected_voucher`: bounced for the
 * voucher it carried, which fails the AA profile locally too).
 */
type HubView =
  | { readonly kind: 'unknown' | 'known' | 'rejected_voucher' }
  | { readonly kind: 'bounced'; readonly error: string };

export class Defender {
  private readonly log: Logger;
  private readonly now: () => number;
  private running: Promise<void> | undefined;
  /** A push and the poll pass never defend one channel at the same time. */
  private readonly channels = new KeyedQueue();
  /** ALL compose + post, one at a time: concurrent ones could spend the same coins. */
  private readonly composer = new KeyedQueue();
  /** Last ALERT per (aa, kind), so it is logged once (bounded by channels × 3). */
  private readonly alerted = new Map<string, string>();
  /** The hub lag ALERT is logged once per episode. */
  private hubLagging = false;

  constructor(private readonly options: DefenderOptions) {
    this.log = moduleLogger(options.logger, 'watcher.defender');
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private get hubTimeoutMs(): number {
    return this.options.hubTimeoutMs ?? 15_000;
  }

  /** One pass over all channels; concurrent calls share the running pass. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  /** Defends one channel right away (e.g. on a `light/aa_response` push). */
  async defendNow(aa: string): Promise<void> {
    const channel = await this.options.store.channel(aa);
    if (channel !== undefined) await this.guarded(aa, channel.timeout);
  }

  private async pass(): Promise<void> {
    await this.checkHubLag();
    for (const channel of await this.options.store.channels()) {
      await this.guarded(channel.aa, channel.timeout);
    }
  }

  private async guarded(aa: string, timeout: number): Promise<void> {
    try {
      await this.channels.run(aa, () => this.defend(aa, timeout));
    } catch (err) {
      this.log.error({ err, aa }, 'defending a channel failed');
    }
  }

  /** One hub is trusted for the channel state: ALERT when it lags (it may hide a client close). */
  private async checkHubLag(): Promise<void> {
    const props = await hubCall(
      () => this.options.client.api.getLastStableUnitProps(),
      this.hubTimeoutMs,
    );
    const ts =
      props.kind === 'ok' ? (props.value as { timestamp?: unknown } | null)?.timestamp : undefined;
    if (typeof ts !== 'number') {
      this.log.warn({ error: problem(props) }, 'cannot read the hub last stable unit');
      return;
    }
    const lag = this.now() - ts;
    if (lag > HUB_MAX_LAG_SECONDS === this.hubLagging) return;
    this.hubLagging = !this.hubLagging;
    if (this.hubLagging) {
      this.log.error(
        { lagSeconds: lag, lastStableTs: ts },
        'ALERT: the hub lags behind the wall clock; channel state may be stale (client closes seen late)',
      );
    } else {
      this.log.info({ lagSeconds: lag }, 'the hub caught up with the wall clock');
    }
  }

  private async defend(aa: string, timeout: number): Promise<void> {
    const { store, policy } = this.options;
    const vars = await hubCall(
      () => this.options.client.api.getAaStateVars({ address: aa }),
      this.hubTimeoutMs,
    );
    const raw = vars.kind === 'ok' ? parseStateVars(vars.value) : undefined;
    const state = raw === undefined ? undefined : channelState(raw);
    if (state === undefined) {
      this.log.warn({ aa, error: problem(vars) }, 'cannot read channel state; skipping this tick');
      return;
    }
    if (state.period === undefined) return;
    const period = state.period;
    // A finished close (the channel moved to a new period) no longer blocks vouchers.
    if ((await store.finishCloses(aa, period)) > 0) await this.announce(this.log);
    const log = this.log.child({ aa, period });
    const now = this.now();
    if (state.closeInitiatedBy === 'B')
      await this.noteClientClose(aa, period, state, timeout, now, log);

    const decideWith = (best: BestVoucher | undefined) =>
      decide({ state, best, timeout, now, policy });
    const first = decideWith(await store.best(aa, period));
    if (first.alert !== undefined) log.error({ why: first.alert }, 'INVARIANT ALERT');
    if (first.action === 'none') {
      log.trace({ why: first.why }, 'no action');
      return;
    }
    // The hub is asked about a sent unit BEFORE the transaction (no network
    // wait while the database is held). Action rows of this channel only
    // change inside this per-channel queue, so the row stays as read.
    const row = await store.action(aa, period, first.action);
    let hub =
      row?.status === 'sent' && row.unit !== null ? await this.hubView(aa, row.unit) : undefined;
    if (row !== undefined && hub?.kind === 'bounced') {
      // A bounce definitely did not land: the row no longer blocks vouchers
      // nor makes the channel "closing"; it is re-sent (or given up) by plan.
      const ctx = { action: first.action, attempts: row.attempts, aaError: hub.error };
      log.warn(ctx, 'sent trigger bounced');
      await store.recordAction({ ...row, status: 'failed', error: hub.error }); // same unit and voucher
      if (hub.error.includes(INVALID_PEER_SIGNATURE) && row.voucherSeq !== null) {
        const reason = await store.rejectVoucher(row.voucherSeq);
        if (reason !== undefined) {
          // Invalid indeed: the re-send carries the next-best valid voucher.
          log.error(
            { ...ctx, voucherSeq: row.voucherSeq, reason },
            'ALERT: the AA rejected our voucher; falling back to the next-best valid voucher',
          );
          hub = { kind: 'rejected_voucher' };
        } else {
          // Kept: a lying hub must not make us drop it (and confirm a dishonest close).
          log.error(
            { ...ctx, voucherSeq: row.voucherSeq },
            'ALERT: our hub reports the AA rejected a voucher that passes the AA profile locally; keeping it (lying hub?), re-sent with backoff',
          );
        }
      }
    }

    const step = await store.atomically(aa, period, async (view) => {
      const best = await view.best();
      const decision = decideWith(best);
      if (decision.action === 'none') return 'wait';
      const go = this.plan(
        decision.action,
        await view.action(decision.action),
        decision.action === first.action ? hub : undefined,
        now,
        log,
      );
      if (go === 'announce') await view.record({ kind: 'close', unit: null, status: 'announced' });
      if (go !== 'send') return go;
      // Committed: from now on saveVoucher refuses vouchers of this period
      // (confirm / sent close), and `best` is what the trigger carries.
      const voucherSeq = decision.action === 'confirm' ? null : (best?.seq ?? null);
      await view.record({ kind: decision.action, unit: null, status: 'sent', voucherSeq });
      return { decision, peer: JSON.parse(best?.packageJson ?? 'null') as unknown };
    });

    if (step === 'wait') return;
    if (step === 'announce') {
      await this.announce(log);
      log.info('close announced; it is sent after the vouchers already in flight');
      return;
    }
    const { decision, peer } = step;
    const data: Record<string, unknown> =
      decision.action === 'confirm'
        ? { confirm: 1, period }
        : decision.action === 'close'
          ? { close: 1, period, transferredFromMe: 0, sentByPeer: peer }
          : { fraud_proof: 1, sentByPeer: peer };
    log.info({ action: decision.action, why: decision.why }, 'sending channel trigger');
    await this.composer.run('compose', () =>
      this.composeAndPost(aa, period, decision.action, data),
    );
  }

  private announce(log: Logger): Promise<void> {
    return (this.options.announce?.() ?? Promise.resolve()).catch((err: unknown) =>
      log.warn({ err }, 'announce failed'),
    );
  }

  /** First sighting of a client close: report the channel closing; ALERT if seen late. */
  private async noteClientClose(
    aa: string,
    period: number,
    state: ChannelState,
    timeout: number,
    now: number,
    log: Logger,
  ): Promise<void> {
    if (!(await this.options.store.noteClientClose(aa, period))) return;
    const start = state.closeStartTs ?? now;
    const remaining = start + timeout - now;
    if (remaining < timeout * LATE_CLOSE_FRACTION) {
      log.error(
        { closeStartTs: start, timeout, remainingSeconds: remaining },
        'ALERT: client close first seen with little of its dispute window left (hub lag or watcher downtime?)',
      );
    } else {
      log.warn({ closeStartTs: start, remainingSeconds: remaining }, 'client started a close');
    }
    await this.announce(log);
  }

  /**
   * Whether a trigger may be sent now (inside the transaction, no I/O):
   * - a seller close is first ANNOUNCED (the facilitator then refuses new
   *   vouchers) and sent `closeAnnounceSeconds` later;
   * - a sent unit the hub KNOWS and the AA did not bounce is never re-sent
   *   (a duplicate would bounce); ALERT if it stays without response;
   * - one the hub does not know is re-sent after {@link LOST_AFTER_SECONDS};
   * - a failed one (bounced, refused by the hub, not composed) is re-sent
   *   after {@link bounceBackoff}, at once if bounced for a voucher that is
   *   invalid (with the next-best); at most {@link MAX_ATTEMPTS} units, then
   *   ALERT.
   */
  private plan(
    kind: ActionKind,
    row: ActionRow | undefined,
    hub: HubView | undefined,
    now: number,
    log: Logger,
  ): 'send' | 'announce' | 'wait' {
    const start = kind === 'close' ? 'announce' : 'send';
    if (row === undefined) return start;
    const age = now - row.updatedAt;
    if (row.status === 'announced') {
      return age >= (this.options.closeAnnounceSeconds ?? DEFAULT_CLOSE_ANNOUNCE_SECONDS)
        ? 'send'
        : 'wait';
    }
    const ctx = { action: kind, unit: row.unit, attempts: row.attempts };
    if (row.status === 'failed') {
      if (row.attempts >= MAX_ATTEMPTS) {
        this.alertOnce(row, 'gave_up', () =>
          log.error(
            ctx,
            'ALERT: trigger bounced on every attempt; giving up re-sending (operator needed)',
          ),
        );
        return 'wait';
      }
      return hub?.kind === 'rejected_voucher' || age >= bounceBackoff(row.attempts)
        ? start
        : 'wait';
    }
    if (row.status !== 'sent') return 'wait';
    if (row.unit === null) {
      log.warn(ctx, 'trigger decided but never posted; sending');
      return 'send';
    }
    switch (hub?.kind) {
      case 'unknown':
        if (age < LOST_AFTER_SECONDS) return 'wait';
        log.warn(ctx, 'sent trigger unknown to the hub; re-sending');
        return 'send';
      case 'known':
        if (age >= STUCK_ALERT_SECONDS) {
          this.alertOnce(row, 'stuck', () =>
            log.error(
              { ...ctx, ageSeconds: age },
              'ALERT: sent trigger known to the hub but without an AA response for long (not re-sent: a duplicate would bounce)',
            ),
          );
        }
        return 'wait';
      default: // the hub cannot tell now
        return 'wait';
    }
  }

  private alertOnce(row: ActionRow, what: string, alert: () => void): void {
    const key = `${row.aa}:${row.kind}`;
    const tag = `${row.period}:${row.unit}:${what}`;
    if (this.alerted.get(key) === tag) return;
    this.alerted.set(key, tag);
    alert();
  }

  /** What the hub knows of a sent unit (undefined: cannot tell now). */
  private async hubView(aa: string, unit: string): Promise<HubView | undefined> {
    const api = this.options.client.api;
    const joint = await hubCall(() => api.getJoint(unit), this.hubTimeoutMs);
    if (joint.kind !== 'ok') return undefined;
    const j = joint.value as { joint?: unknown; joint_not_found?: unknown } | null;
    if (j === null || typeof j !== 'object') return undefined;
    if (j.joint_not_found !== undefined || j.joint === undefined) return { kind: 'unknown' };
    const chain = await hubCall(
      () => api.getAaResponseChain({ trigger_unit: unit }),
      this.hubTimeoutMs,
    );
    const ours =
      chain.kind === 'ok' && Array.isArray(chain.value)
        ? (chain.value as { aa_address?: unknown; bounced?: unknown; response?: unknown }[]).find(
            (r) => r.aa_address === aa,
          )
        : undefined;
    return ours?.bounced === 1 || ours?.bounced === true
      ? { kind: 'bounced', error: bounceError(ours.response) }
      : { kind: 'known' };
  }

  private async composeAndPost(
    aa: string,
    period: number,
    kind: ActionKind,
    data: Record<string, unknown>,
  ): Promise<void> {
    const { client, store } = this.options;
    // A compose that fails or times out was never posted (posting is the
    // separate step below): a definite failure, retried by the next pass.
    const composed = await hubCall(
      () =>
        client.compose.message(
          'multi',
          [
            { app: 'payment', payload: { outputs: [{ address: aa, amount: TRIGGER_AMOUNT }] } },
            { app: 'data', payload: data },
          ] as never,
          { privateKey: this.options.privateKey, testnet: this.options.testnet },
        ) as unknown as Promise<Record<string, unknown>>,
      this.options.composeTimeoutMs ?? 60_000,
    );
    if (composed.kind !== 'ok') {
      await store.recordAction({
        aa,
        period,
        kind,
        unit: null,
        status: 'failed',
        error: composed.error,
      });
      this.log.error({ aa, kind, error: composed.error }, 'cannot compose trigger (enough bytes?)');
      return;
    }
    const unit = composed.value;
    const hash = String(unit['unit']);
    // Recorded before the broadcast: an unknown outcome (e.g. the post timed
    // out) still prevents a duplicate until LOST_AFTER_SECONDS.
    await store.recordAction({ aa, period, kind, unit: hash, status: 'sent', attempt: 1 });
    const posted = await hubCall(() => client.api.postJoint({ unit } as never), this.hubTimeoutMs);
    // A hub error means "not broadcast" only if the hub does not know the
    // unit either (e.g. not "already handling this unit"); else it stays sent.
    if (posted.kind === 'hub_error' && (await this.hubView(aa, hash))?.kind === 'unknown') {
      await store.recordAction({
        aa,
        period,
        kind,
        unit: hash,
        status: 'failed',
        error: posted.error,
        attempt: -1, // definitely refused: not counted toward MAX_ATTEMPTS
      });
      this.log.error({ aa, kind, hubError: posted.error }, 'hub rejected the trigger');
      return;
    }
    this.log.info({ aa, kind, unit: hash, outcome: posted.kind }, 'trigger broadcast');
  }
}

/** Why a hub answer is unusable (its error, or a malformed value). */
function problem(outcome: { kind: string; error?: string }): string {
  return outcome.error ?? 'malformed answer';
}

/** The error of a bounced AA response (`response` may be an object or its JSON). */
function bounceError(response: unknown): string {
  let r = response;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r) as unknown;
    } catch {
      return r as string;
    }
  }
  const error = (r as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : 'bounced';
}
