import obyte from 'obyte';
import {
  type ChannelParams,
  type ObyteNetwork,
  parseChannelDefinition,
  verifySignedPackage,
} from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  type CommitmentMessage,
  type ReceiptKind,
  WATCHER_PROTOCOL_VERSION,
  canonical,
  hubCall,
  loginMessage,
  packageHashOf,
  receiptMessage,
  serverMessageSchema,
  voucherMessageSchema,
} from '@obbyx/x402-obyte';
import type { KnownChannel, WatcherStore } from '../storage/store.js';

/**
 * Link from the seller's watcher to the facilitator (`/watcher` WebSocket).
 * Logs in with the seller key, sends its cursor, then for every voucher:
 * validates it independently (client signature, channel of THIS seller from
 * the on-chain definition, consistent fields), stores it durably and only then
 * sends a SIGNED ack for its exact package. An invalid voucher is never acked,
 * so it is never reported as paid; a definitely refused one gets a signed
 * nack (the facilitator cancels it and frees the channel). A transient
 * problem (hub unreachable) gets no answer: the voucher is replayed later.
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
  /** Called for a channel seen for the first time (to start watching it on the hub). */
  readonly onNewChannel?: (aa: string) => void;
}

export class FacilitatorLink {
  private ws: WebSocket | undefined;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private backoffMs = 1_000;
  private readonly definitions = new Map<string, ChannelParams>();
  private readonly log: Logger;
  connected = false;

  constructor(private readonly options: FacilitatorLinkOptions) {
    this.log = moduleLogger(options.logger, 'watcher.link', { seller: options.seller });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.ws?.close(1000, 'watcher stopping');
  }

  private connect(): void {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.addEventListener('message', (e) => void this.handle(ws, String(e.data)));
    ws.addEventListener('close', (e) => {
      this.connected = false;
      clearInterval(this.heartbeat);
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
        return this.onCommitment(ws, msg);
    }
  }

  private async onCommitment(ws: WebSocket, msg: CommitmentMessage): Promise<void> {
    const packageHash = packageHashOf(msg.signedPackage);
    const log = this.log.child({ seq: msg.seq, aa: msg.aa, proofId: packageHash });
    const reply = (kind: ReceiptKind, reason?: string) =>
      this.sendReceipt(ws, kind, msg.seq, packageHash, reason);
    const verdict = await this.validate(msg);
    switch (verdict.kind) {
      case 'transient':
        log.warn({ problem: verdict.reason }, 'cannot validate the voucher now — no answer yet');
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
    reply('ack'); // only after the durable write (and again for a re-delivery)
    log.info({ amountSpent: msg.amountSpent }, 'voucher stored and acked');
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
    const verified = verifySignedPackage<unknown>(msg.signedPackage, {
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
    let params = this.definitions.get(msg.aa);
    if (params === undefined) {
      this.options.onNewChannel?.(msg.aa);
      const def = await hubCall(
        () => this.options.client.api.getDefinition(msg.aa),
        this.options.hubTimeoutMs ?? 15_000,
      );
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
    return {
      kind: 'ok',
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
  | { readonly kind: 'ok'; readonly channel: KnownChannel }
  | { readonly kind: 'refuse' | 'transient' | 'anomaly'; readonly reason: string };
