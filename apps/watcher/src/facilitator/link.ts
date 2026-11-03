import obyte from 'obyte';
import {
  type ChannelParams,
  type ObyteNetwork,
  parseChannelDefinition,
  verifySignedPackage,
} from '@obbyx/obyte';
import { createHash } from 'node:crypto';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  type CommitmentMessage,
  canonical,
  hubCall,
  loginMessage,
  serverMessageSchema,
  voucherMessageSchema,
} from '@obbyx/x402-obyte';
import type { WatcherStore } from '../storage/store.js';

/**
 * Link from the seller's watcher to the facilitator (`/watcher` WebSocket).
 * Logs in with the seller key, sends its cursor, then for every voucher:
 * validates it independently (client signature, channel of THIS seller from
 * the on-chain definition, consistent fields), stores it durably and only then
 * acks. An invalid voucher is never acked, so it is never reported as paid.
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
            network: this.options.network.caip2,
            login,
            cursor: await this.options.store.cursor(),
            bytesBalance: (await this.options.bytesBalance()).toString(),
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
    const log = this.log.child({
      seq: msg.seq,
      aa: msg.aa,
      proofId: createHash('sha256').update(canonical(msg.signedPackage)).digest('hex'),
    });
    const problem = await this.validate(msg);
    if (typeof problem === 'string') {
      log.error({ problem }, 'voucher rejected — NOT acked');
      return;
    }
    await this.options.store.saveVoucher({
      seq: msg.seq,
      network: msg.network,
      aa: msg.aa,
      period: msg.period,
      amountSpent: BigInt(msg.amountSpent),
      paymentAmount: BigInt(msg.paymentAmount),
      binding: msg.binding,
      packageJson: canonical(msg.signedPackage),
      channel: problem,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }));
    log.info({ amountSpent: msg.amountSpent }, 'voucher stored and acked');
  }

  /** Returns the channel on success, or a reason string. */
  private async validate(msg: CommitmentMessage) {
    if (msg.network !== this.options.network.caip2) return 'wrong network';
    const verified = verifySignedPackage<unknown>(msg.signedPackage, {
      network: this.options.network,
    });
    if (!verified.ok) return `bad signature: ${verified.message}`;
    const v = voucherMessageSchema.safeParse(verified.value.message);
    if (!v.success) return 'malformed voucher';
    if (
      v.data.aa_address !== msg.aa ||
      v.data.period !== msg.period ||
      String(v.data.amount_spent) !== msg.amountSpent ||
      String(v.data.payment_amount) !== msg.paymentAmount ||
      v.data.binding !== msg.binding
    ) {
      return 'voucher fields do not match the message';
    }
    let params = this.definitions.get(msg.aa);
    if (params === undefined) {
      this.options.onNewChannel?.(msg.aa);
      const def = await hubCall(
        () => this.options.client.api.getDefinition(msg.aa),
        this.options.hubTimeoutMs ?? 15_000,
      );
      if (def.kind !== 'ok') return `cannot read channel definition: ${def.error}`;
      const parsed = parseChannelDefinition(msg.aa, def.value);
      if (!parsed.ok) return parsed.message;
      params = parsed.value;
      this.definitions.set(msg.aa, params);
    }
    if (params.addressA !== this.options.seller) return 'channel does not pay this seller';
    if (params.addressB !== verified.value.signer)
      return 'voucher not signed by the channel client';
    return {
      aa: msg.aa,
      network: msg.network,
      payer: params.addressB,
      asset: params.asset,
      timeout: params.timeout,
    };
  }

  private async sendHeartbeat(ws: WebSocket): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        cursor: await this.options.store.cursor(),
        bytesBalance: (await this.options.bytesBalance()).toString(),
      }),
    );
  }
}
