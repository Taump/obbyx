import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { getNetwork, isObyteNetwork } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  type BatchStore,
  type ClientMessage,
  type CommitmentRow,
  type ServerMessage,
  type SettlementEvent,
  type WatcherGateway,
  type WatcherHealth,
  clientMessageSchema,
  verifyWatcherLogin,
} from '@obbyx/x402-obyte';

/**
 * WebSocket gateway to sellers' watchers (implements the WatcherGateway port).
 * One session per (network, seller); a new login replaces the old session.
 * Every ack commits the voucher (idempotent), which also reconciles vouchers
 * left pending while the watcher was away.
 */
export interface WsWatcherGatewayOptions {
  readonly store: BatchStore;
  readonly logger: Logger;
  readonly networks: readonly string[];
  /** Minimum bytes a watcher must hold for defensive triggers. */
  readonly minBytes: bigint;
  readonly heartbeatTimeoutMs: number;
  /** Payment event journal (e.g. the facilitator's `events` table). */
  readonly events?: (event: SettlementEvent) => Promise<void>;
  readonly now?: () => number;
}

interface Session {
  readonly ws: WebSocket;
  readonly seller: string;
  readonly network: string;
  lastSeen: number;
  bytesBalance: bigint;
}

export class WsWatcherGateway implements WatcherGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly waiters = new Map<number, Set<() => void>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly options: WsWatcherGatewayOptions) {
    this.log = moduleLogger(options.logger, 'facilitator.watchers');
    this.now = options.now ?? (() => Date.now());
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /** Accepts WebSocket upgrades on `/watcher` of an existing HTTP server. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/watcher') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  health(payTo: string, network: string): WatcherHealth {
    const s = this.sessions.get(sessionKey(network, payTo));
    if (s === undefined || s.ws.readyState !== WebSocket.OPEN)
      return { ok: false, reason: "The seller's watcher is not connected" };
    if (this.now() - s.lastSeen > this.options.heartbeatTimeoutMs) {
      return { ok: false, reason: "The seller's watcher heartbeat is stale" };
    }
    if (s.bytesBalance < this.options.minBytes) {
      return {
        ok: false,
        reason: "The seller's watcher has too few bytes for defensive transactions",
      };
    }
    return { ok: true };
  }

  async deliver(commitment: CommitmentRow, timeoutMs: number): Promise<'acked' | 'timeout'> {
    const s = this.sessions.get(sessionKey(commitment.network, commitment.payTo));
    if (s === undefined || s.ws.readyState !== WebSocket.OPEN) return 'timeout';
    let waiter: (() => void) | undefined;
    const acked = new Promise<'acked'>((resolve) => {
      waiter = () => resolve('acked');
      this.onAck(commitment.seq, waiter);
    });
    this.send(s.ws, toMessage(commitment));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      return await Promise.race([acked, timeout]);
    } finally {
      clearTimeout(timer);
      // Never leave a waiter behind (a timed-out delivery would leak one per retry).
      const set = this.waiters.get(commitment.seq);
      if (set !== undefined && waiter !== undefined) {
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(commitment.seq);
      }
    }
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) s.ws.close(1001, 'facilitator shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    const challenge = randomBytes(24).toString('base64url');
    let session: Session | undefined;
    const loginTimer = setTimeout(() => {
      if (session === undefined) this.fail(ws, 'login timeout');
    }, 15_000);
    this.send(ws, { type: 'challenge', challenge });

    ws.on('message', (raw) => {
      void (async () => {
        let msg: ClientMessage;
        try {
          msg = clientMessageSchema.parse(JSON.parse(String(raw)));
        } catch {
          return this.fail(ws, 'malformed message');
        }
        if (msg.type === 'hello') {
          if (session !== undefined) return this.fail(ws, 'already logged in');
          if (!isObyteNetwork(msg.network) || !this.options.networks.includes(msg.network)) {
            return this.fail(ws, 'network not served');
          }
          const login = verifyWatcherLogin(msg.login, {
            challenge,
            network: getNetwork(msg.network),
            now: Math.floor(this.now() / 1000),
          });
          if (!login.ok) return this.fail(ws, login.message);
          clearTimeout(loginTimer);
          session = {
            ws,
            seller: login.value,
            network: msg.network,
            lastSeen: this.now(),
            bytesBalance: BigInt(msg.bytesBalance),
          };
          const key = sessionKey(msg.network, login.value);
          this.sessions.get(key)?.ws.close(4000, 'replaced by a new watcher session');
          this.sessions.set(key, session);
          this.send(ws, { type: 'welcome', seller: login.value, network: msg.network });
          this.log.info(
            { seller: login.value, network: msg.network, cursor: msg.cursor },
            'watcher connected',
          );
          void this.emit(msg.network, login.value, 'watcher_connected', { cursor: msg.cursor });
          await this.replay(session, msg.cursor);
          return;
        }
        if (session === undefined) return this.fail(ws, 'login first');
        session.lastSeen = this.now();
        if (msg.type === 'heartbeat') {
          session.bytesBalance = BigInt(msg.bytesBalance);
          return;
        }
        // ack: durable on the watcher → committed here (idempotent).
        // Ownership is enforced atomically inside commit (seller + network).
        const committed = await this.options.store.commit(msg.seq, {
          payTo: session.seller,
          network: session.network,
        });
        if (committed === undefined) {
          this.log.warn({ seq: msg.seq }, 'ack for an unknown or foreign voucher ignored');
          return;
        }
        this.log.debug({ seq: msg.seq, seller: session.seller }, 'watcher ack');
        void this.emit(session.network, session.seller, 'watcher_ack', { seq: msg.seq });
        for (const resolve of this.waiters.get(msg.seq) ?? []) resolve();
        this.waiters.delete(msg.seq);
      })().catch((err: unknown) => this.log.error({ err }, 'watcher message handling failed'));
    });

    ws.on('close', () => {
      clearTimeout(loginTimer);
      if (session !== undefined) {
        const key = sessionKey(session.network, session.seller);
        if (this.sessions.get(key) === session) this.sessions.delete(key);
        this.log.info({ seller: session.seller }, 'watcher disconnected');
        void this.emit(session.network, session.seller, 'watcher_disconnected', {});
      }
    });
  }

  private async emit(
    network: string,
    seller: string,
    kind: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.options.events?.({ key: `${network}:watcher:${seller}`, kind, data });
    } catch (err) {
      this.log.error({ err, kind }, 'cannot write payment event');
    }
  }

  private async replay(session: Session, cursor: number): Promise<void> {
    let after = cursor;
    for (;;) {
      const batch = await this.options.store.journal(session.seller, after, 200);
      const ours = batch.filter((c) => c.network === session.network);
      for (const c of ours) this.send(session.ws, toMessage(c));
      if (batch.length < 200) break;
      after = batch[batch.length - 1]?.seq ?? after;
    }
  }

  private onAck(seq: number, resolve: () => void): void {
    const set = this.waiters.get(seq) ?? new Set();
    set.add(resolve);
    this.waiters.set(seq, set);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private fail(ws: WebSocket, message: string): void {
    this.log.warn({ reason: message }, 'watcher connection rejected');
    this.send(ws, { type: 'error', message });
    ws.close(4001, message.slice(0, 100));
  }
}

function sessionKey(network: string, seller: string): string {
  return `${network}:${seller}`;
}

function toMessage(c: CommitmentRow): ServerMessage {
  return {
    type: 'commitment',
    seq: c.seq,
    network: c.network,
    aa: c.aa,
    period: c.period,
    amountSpent: c.amountSpent.toString(),
    paymentAmount: c.paymentAmount.toString(),
    binding: c.binding,
    signedPackage: JSON.parse(c.packageJson) as Record<string, unknown>,
    state: c.state,
  };
}
