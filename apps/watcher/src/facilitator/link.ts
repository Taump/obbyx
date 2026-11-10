import obyte from 'obyte';
import {
  type ChannelParams,
  type ObyteNetwork,
  parseChannelDefinition,
  verifyVoucherPackage,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  type CommitmentMessage,
  type ReceiptKind,
  KeyedQueue,
  WATCHER_PROTOCOL_VERSION,
  canonical,
  hubCall,
  loginMessage,
  packageHashOf,
  parseStateVars,
  receiptMessage,
  serverMessageSchema,
  voucherMessageSchema,
} from '@obbyx/x402-obyte';
import type { KnownChannel, WatcherStore } from '../storage/store.js';
import { channelState } from '../chain/decide.js';
import { MIN_CHANNEL_TIMEOUT_SECONDS } from '../config.js';
/** Local retries of a voucher that could not be judged (hub problem), while connected. */
export const DEFAULT_RETRY = { baseMs: 2_000, maxMs: 60_000, attempts: 8, pending: 1_000 };

/**
 * Link from the seller's watcher to the facilitator (`/watcher` WebSocket).
 * Logs in with the seller key, sends its cursor, then for every voucher:
 * validates it independently (client signature, channel of THIS seller from
 * the on-chain definition, consistent fields), stores it durably and only then
 * sends a SIGNED ack for its exact package. An invalid voucher is never acked,
 * so it is never reported as paid; a definitely refused one gets a signed
 * nack (the facilitator cancels it and frees the channel). A transient
 * problem (hub unreachable) gets no answer: the voucher is retried locally
 * with a bounded backoff while connected, and replayed by the facilitator
 * after a reconnection.
 */
export interface FacilitatorLinkOptions {
  readonly url: string;
  readonly network: ObyteNetwork;
  readonly seller: string;
  readonly privateKey: Uint8Array;
  readonly client: obyte.Client;
  readonly store: WatcherStore;
  readonly logger: Logger;
  readonly heartbeatMs?: number;
  readonly hubTimeoutMs?: number;
  /** Current bytes balance of the seller (for the facilitator's health check). */
  readonly bytesBalance: () => Promise<bigint>;
  /** Called for a channel first seen with a VALID voucher (to start watching it on the hub). */
  readonly onNewChannel?: (aa: string) => void;
  /**
   * Called after a voucher was stored while the client is closing the channel
   * (it may enable a fraud proof: defend the channel now).
   */
  readonly onClosingVoucher?: (aa: string) => void;
  /** Vouchers of channels with a shorter dispute window are refused (default {@link MIN_CHANNEL_TIMEOUT_SECONDS}). */
  readonly minChannelTimeout?: number;
  /** Local retry of transient validation failures (see {@link DEFAULT_RETRY}). */
  readonly retry?: Partial<typeof DEFAULT_RETRY>;
}

export class FacilitatorLink {
  private ws: WebSocket | undefined;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private backoffMs = 1_000;
  private readonly definitions = new Map<string, ChannelParams>();
  private readonly watched = new Set<string>();
  /** Pending local retries of transient commitments, by seq. */
  private readonly retries = new Map<number, NodeJS.Timeout>();
  private readonly retry: typeof DEFAULT_RETRY;
  /**
   * One package is judged at a time: a fired retry timer and a fresh delivery
   * of the same package would otherwise both pass `hasVoucher`, and the
   * second could nack (e.g. its period closed meanwhile) what the first acked.
   */
  private readonly judging = new KeyedQueue();
  private readonly log: Logger;
  connected = false;

  constructor(private readonly options: FacilitatorLinkOptions) {
    this.log = moduleLogger(options.logger, 'watcher.link', { seller: options.seller });
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.clearRetries();
    this.ws?.close(1000, 'watcher stopping');
  }

  private connect(): void {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.addEventListener('message', (e) => void this.handle(ws, String(e.data)));
    ws.addEventListener('close', (e) => {
      this.connected = false;
      clearInterval(this.heartbeat);
      this.clearRetries(); // the facilitator replays them after the reconnection
      if (this.stopped) return;
      this.log.warn(
        { code: e.code, reason: e.reason, retryMs: this.backoffMs },
        'facilitator link closed; reconnecting',
      );
      setTimeout(() => this.connect(), this.backoffMs).unref();
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    ws.addEventListener('error', () => undefined); // close follows
  }

  /** A bad message or a failing handler must never stop the watcher. */
  private async handle(ws: WebSocket, raw: string): Promise<void> {
    try {
      await this.onMessage(ws, raw);
    } catch (err) {
      this.log.error(
        { err },
        'failed to handle a facilitator message (not acked; it will be replayed)',
      );
    }
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.log.warn('ignoring non-JSON message from facilitator');
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return this.log.warn('ignoring malformed message from facilitator');
    const msg = parsed.data;
    switch (msg.type) {
      case 'challenge': {
        const now = Math.floor(Date.now() / 1000);
        const login = obyte.utils.signMessage(
          loginMessage(msg.challenge, this.options.network.caip2, now),
          {
            privateKey: this.options.privateKey,
            testnet: this.options.network.testnet,
          },
        );
        ws.send(
          JSON.stringify({
            type: 'hello',
            protocol: WATCHER_PROTOCOL_VERSION,
            network: this.options.network.caip2,
            login,
            cursor: await this.options.store.cursor(),
            bytesBalance: (await this.options.bytesBalance()).toString(),
            closing: await this.options.store.closingChannels(),
          }),
        );
        return;
      }
      case 'welcome':
        this.connected = true;
        this.backoffMs = 1_000;
        this.log.info({ network: msg.network }, 'connected to facilitator');
        clearInterval(this.heartbeat); // a repeated welcome must not leak a timer
        this.heartbeat = setInterval(
          () =>
            void this.sendHeartbeat(ws).catch((err: unknown) =>
              this.log.warn({ err }, 'heartbeat failed'),
            ),
          this.options.heartbeatMs ?? 10_000,
        );
        this.heartbeat.unref();
        return;
      case 'error':
        this.log.error({ message: msg.message }, 'facilitator rejected the watcher');
        return;
      case 'commitment':
        this.cancelRetry(msg.seq); // a fresh delivery supersedes a local retry
        return this.onCommitment(ws, msg, 0);
    }
  }

  private clearRetries(): void {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private cancelRetry(seq: number): void {
    clearTimeout(this.retries.get(seq));
    this.retries.delete(seq);
  }

  /**
   * Retries a commitment that could not be judged, with exponential backoff,
   * on the same connection only and a bounded number of times (then the
   * facilitator's replay after a reconnection takes over).
   */
  private scheduleRetry(ws: WebSocket, msg: CommitmentMessage, attempt: number, log: Logger): void {
    if (this.stopped) return;
    if (attempt >= this.retry.attempts) {
      log.warn({ attempts: attempt }, 'giving up local retries; the voucher waits for a replay');
      return;
    }
    if (!this.retries.has(msg.seq) && this.retries.size >= this.retry.pending) {
      log.warn('too many vouchers awaiting a retry; this one waits for a replay');
      return;
    }
    this.cancelRetry(msg.seq);
    const delay = Math.min(this.retry.baseMs * 2 ** attempt, this.retry.maxMs);
    const timer = setTimeout(() => {
      this.retries.delete(msg.seq);
      if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      this.onCommitment(ws, msg, attempt + 1).catch((err: unknown) =>
        log.error({ err }, 'retrying a voucher failed'),
      );
    }, delay);
    timer.unref();
    this.retries.set(msg.seq, timer);
  }

  private onCommitment(ws: WebSocket, msg: CommitmentMessage, attempt: number): Promise<void> {
    const packageHash = packageHashOf(msg.signedPackage);
    return this.judging.run(packageHash, () => this.judge(ws, msg, attempt, packageHash));
  }

  private async judge(
    ws: WebSocket,
    msg: CommitmentMessage,
    attempt: number,
    packageHash: string,
  ): Promise<void> {
    const log = this.log.child({ seq: msg.seq, aa: msg.aa, proofId: packageHash });
    const reply = (kind: ReceiptKind, reason?: string) =>
      this.sendReceipt(ws, kind, msg.seq, packageHash, reason);
    // A package we already stored (re-delivery, possibly after its period
    // closed or our confirm) was validated then: acking it again is true, and
    // a nack would contradict the ack the facilitator already holds.
    if (await this.options.store.hasVoucher(msg.aa, msg.period, canonical(msg.signedPackage))) {
      reply('ack');
      log.info({ amountSpent: msg.amountSpent }, 'voucher already stored; acked again');
      return;
    }
    const verdict = await this.validate(msg);
    switch (verdict.kind) {
      case 'transient':
        log.warn(
          { problem: verdict.reason, attempt },
          'cannot validate the voucher now — no answer yet, retrying',
        );
        this.scheduleRetry(ws, msg, attempt, log);
        return;
      case 'anomaly':
        // Answering would let whoever altered the unsigned envelope cancel a
        // valid voucher: no answer, the operator investigates.
        log.error({ problem: verdict.reason }, 'INVARIANT ALERT: voucher envelope — not answered');
        return;
      case 'refuse':
        log.error({ problem: verdict.reason }, 'voucher refused — NOT stored, nacked');
        reply('nack', verdict.reason);
        return;
      case 'ok':
        break;
    }
    const saved = await this.options.store.saveVoucher({
      seq: msg.seq,
      network: msg.network,
      aa: msg.aa,
      period: msg.period,
      amountSpent: BigInt(msg.amountSpent),
      paymentAmount: BigInt(msg.paymentAmount),
      binding: msg.binding,
      packageJson: canonical(msg.signedPackage),
      channel: verdict.channel,
      clientClosing: verdict.clientClosing,
    });
    if (saved.kind === 'seq_conflict') {
      // Neither ack nor nack: our stored voucher under this seq is real; the
      // facilitator's journal disagrees with ours and needs the operator.
      log.error(
        'INVARIANT ALERT: this seq already holds a different voucher (facilitator journal reset or another facilitator?) — not answered',
      );
      return;
    }
    if (saved.kind === 'not_increasing') {
      // Never pay for a request twice: not acked, so the facilitator never
      // reports it paid. Means the same channel is used through another
      // facilitator (or a facilitator bug) — needs the operator.
      log.error(
        { amountSpent: msg.amountSpent, best: saved.best.toString() },
        'INVARIANT ALERT: voucher does not raise the cumulative amount — NOT stored, nacked',
      );
      reply('nack', 'not_increasing');
      return;
    }
    if (saved.kind === 'settling') {
      // We already committed to a confirm / sent our close for this period:
      // the voucher can never reach the chain, so it is never reported paid.
      log.warn(
        { action: saved.action, status: saved.status },
        'voucher arrived after the period started settling — NOT stored, nacked',
      );
      reply('nack', 'channel_settling');
      return;
    }
    // Only a voucher that was stored starts the watch of its AA.
    if (!this.watched.has(msg.aa)) {
      this.watched.add(msg.aa);
      this.options.onNewChannel?.(msg.aa);
    }
    reply('ack'); // only after the durable write (and again for a re-delivery)
    log.info({ amountSpent: msg.amountSpent }, 'voucher stored and acked');
    if (verdict.clientClosing) this.options.onClosingVoucher?.(msg.aa);
  }

  /**
   * `refuse` (nacked) ONLY for reasons intrinsic to the client-signed package
   * and the on-chain channel; a mismatch with the unsigned envelope is an
   * `anomaly` (see watcher-protocol.ts, "Receipts"); `transient` cannot be
   * judged now and is replayed later.
   */
  private async validate(msg: CommitmentMessage): Promise<Verdict> {
    if (msg.network !== this.options.network.caip2)
      return { kind: 'anomaly', reason: 'wrong network' };
    // The AA profile: a package with e.g. `timestamp`, `last_ball_unit` or an
    // old version is validly signed but `is_valid_signed_package` rejects it,
    // so it could never be used in a close or a fraud proof.
    const verified = verifyVoucherPackage<unknown>(msg.signedPackage, {
      network: this.options.network,
    });
    if (!verified.ok) return { kind: 'refuse', reason: `bad signature: ${verified.message}` };
    const v = voucherMessageSchema.safeParse(verified.value.message);
    if (!v.success) return { kind: 'refuse', reason: 'malformed voucher' };
    if (
      v.data.aa_address !== msg.aa ||
      v.data.period !== msg.period ||
      String(v.data.amount_spent) !== msg.amountSpent ||
      String(v.data.payment_amount) !== msg.paymentAmount ||
      v.data.binding !== msg.binding
    ) {
      return { kind: 'anomaly', reason: 'voucher fields do not match the message' };
    }
    const t = this.options.hubTimeoutMs ?? 15_000;
    let params = this.definitions.get(msg.aa);
    if (params === undefined) {
      const def = await hubCall(() => this.options.client.api.getDefinition(msg.aa), t);
      if (def.kind !== 'ok')
        return { kind: 'transient', reason: `cannot read channel definition: ${def.error}` };
      // Our hub may not know a fresh AA yet: not a refusal.
      if (def.value === null || def.value === undefined) {
        return { kind: 'transient', reason: 'channel definition not known to our hub yet' };
      }
      const parsed = parseChannelDefinition(msg.aa, def.value);
      if (!parsed.ok) return { kind: 'refuse', reason: parsed.message };
      params = parsed.value;
      this.definitions.set(msg.aa, params);
    }
    if (params.addressA !== this.options.seller) {
      return { kind: 'refuse', reason: 'channel does not pay this seller' };
    }
    if (params.addressB !== verified.value.signer) {
      return { kind: 'refuse', reason: 'voucher not signed by the channel client' };
    }
    const minTimeout = this.options.minChannelTimeout ?? MIN_CHANNEL_TIMEOUT_SECONDS;
    if (params.timeout < minTimeout) {
      return { kind: 'refuse', reason: 'channel_timeout_too_short' };
    }
    // The period must be the one open on-chain: a voucher of a closed period
    // can never be cashed (the AA requires the current period).
    //
    // Accepted residual risk: this read happens OUTSIDE the transaction that
    // saves the voucher and trusts one hub. A client confirm or fraud proof
    // landing between this read and the save (closing the period) makes the
    // acked voucher uncollectable. Our own confirm / sent close cannot slip
    // through: those rows are checked inside the save transaction.
    const vars = await hubCall(
      () => this.options.client.api.getAaStateVars({ address: msg.aa }),
      t,
    );
    if (vars.kind !== 'ok')
      return { kind: 'transient', reason: `cannot read channel state: ${vars.error}` };
    const raw = parseStateVars(vars.value);
    const state = raw === undefined ? undefined : channelState(raw);
    if (state === undefined) return { kind: 'transient', reason: 'malformed channel state' };
    // Our hub may not have seen the deposit / the last close yet.
    if (state.period === undefined)
      return { kind: 'transient', reason: 'channel not opened yet on our hub' };
    if (msg.period < state.period) return { kind: 'refuse', reason: 'period_closed' };
    if (msg.period > state.period)
      return { kind: 'transient', reason: 'voucher period ahead of our hub' };
    // Our close is on-chain: spentByB is fixed, a new voucher can never be
    // collected — whatever our local rows say (e.g. a crash before recording).
    if (state.closeInitiatedBy === 'A') return { kind: 'refuse', reason: 'channel_settling' };
    return {
      kind: 'ok',
      // A client close of THIS period: our own close (if recorded) lost the
      // race, so it does not block a voucher that enables a fraud proof.
      clientClosing: state.closeInitiatedBy === 'B',
      channel: {
        aa: msg.aa,
        network: msg.network,
        payer: params.addressB,
        asset: params.asset,
        timeout: params.timeout,
      },
    };
  }

  /**
   * ack: the voucher is durably stored (the facilitator then reports it paid);
   * nack: it never will be. Signed by the seller for this exact package.
   */
  private sendReceipt(
    ws: WebSocket,
    kind: ReceiptKind,
    seq: number,
    packageHash: string,
    reason?: string,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const receipt = obyte.utils.signMessage(
      receiptMessage(kind, this.options.network.caip2, {
        seq,
        packageHash,
        ...(reason === undefined ? {} : { reason }),
      }),
      { privateKey: this.options.privateKey, testnet: this.options.network.testnet },
    );
    ws.send(JSON.stringify({ type: kind, seq, receipt }));
  }

  /** Sends a heartbeat now (e.g. right after a close is announced). */
  async announce(): Promise<void> {
    if (this.ws !== undefined && this.connected) await this.sendHeartbeat(this.ws);
  }

  private async sendHeartbeat(ws: WebSocket): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        cursor: await this.options.store.cursor(),
        bytesBalance: (await this.options.bytesBalance()).toString(),
        closing: await this.options.store.closingChannels(),
      }),
    );
  }
}

/** Outcome of validating a commitment before it is stored. */
type Verdict =
  | { readonly kind: 'ok'; readonly channel: KnownChannel; readonly clientClosing: boolean }
  | { readonly kind: 'refuse' | 'transient' | 'anomaly'; readonly reason: string };
