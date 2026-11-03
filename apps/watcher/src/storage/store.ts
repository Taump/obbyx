import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { ObbyxError } from '@obbyx/obyte';
import { StoreLockedError } from '@obbyx/x402-obyte';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Watcher database (Prisma + SQLite, one watcher process per file, exclusive
 * lock like the facilitator). Every operation runs in its own transaction
 * because the adapter shares one connection.
 */
export async function openWatcherDatabase(path: string): Promise<PrismaClient> {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${path}`, timeout: 1_000 }),
  });
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe('PRAGMA synchronous = FULL');
    await prisma.$queryRawUnsafe('PRAGMA locking_mode = EXCLUSIVE');
    const now = Math.floor(Date.now() / 1000);
    await prisma.instance.upsert({
      where: { id: 1 },
      create: { id: 1, pid: process.pid, startedAt: now },
      update: { pid: process.pid, startedAt: now },
    });
  } catch (err) {
    await prisma.$disconnect().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    if (/database is locked|SQLITE_BUSY/i.test(message)) throw new StoreLockedError(path, err);
    const code = (err as { code?: unknown }).code;
    if (code === 'P2021' || /no such table|does not exist/i.test(message)) {
      throw new ObbyxError(
        'schema_not_migrated',
        `Database ${path} has no watcher schema. Run: pnpm --filter @obbyx/watcher db:migrate`,
      );
    }
    throw err;
  }
  return prisma;
}

export interface StoredVoucher {
  readonly seq: number;
  readonly aa: string;
  readonly period: number;
  readonly amountSpent: bigint;
  readonly packageJson: string;
  readonly receivedAt: number;
}

export interface KnownChannel {
  readonly aa: string;
  readonly network: string;
  readonly payer: string;
  readonly asset: string;
  readonly timeout: number;
}

export type ActionKind = 'close' | 'confirm' | 'fraud_proof';

/** Close states that make a channel "closing" for the facilitator. */
const CLOSE_IN_PROGRESS = ['announced', 'sent'];

export interface ActionRow {
  readonly aa: string;
  readonly period: number;
  readonly kind: ActionKind;
  readonly unit: string | null;
  /**
   * announced: a close is decided and the facilitator told to accept no new
   * vouchers for the channel; sent: the trigger was broadcast; done: the
   * channel moved to a later period; failed: the trigger could not be sent.
   */
  readonly status: 'announced' | 'sent' | 'done' | 'failed';
  readonly updatedAt: number;
}

export class WatcherStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Highest journal seq stored: the cursor sent to the facilitator. */
  cursor(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => (await tx.voucher.aggregate({ _max: { seq: true } }))._max.seq ?? 0,
    );
  }

  /**
   * Durably stores a voucher (idempotent by seq) and the channel it belongs to.
   * Returns only after the SQLite transaction committed (synchronous = FULL):
   * the caller may then ack to the facilitator.
   */
  saveVoucher(v: {
    seq: number;
    network: string;
    aa: string;
    period: number;
    amountSpent: bigint;
    paymentAmount: bigint;
    binding: string;
    packageJson: string;
    channel: KnownChannel;
  }): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const ts = this.now();
      await tx.channel.upsert({
        where: { aa: v.aa },
        create: { ...v.channel, firstSeen: ts },
        update: {},
      });
      const existing = await tx.voucher.findUnique({ where: { seq: v.seq } });
      if (existing !== null) return;
      await tx.voucher.create({
        data: {
          seq: v.seq,
          network: v.network,
          aa: v.aa,
          period: v.period,
          amountSpent: v.amountSpent.toString(),
          paymentAmount: v.paymentAmount.toString(),
          binding: v.binding,
          packageJson: v.packageJson,
          receivedAt: ts,
        },
      });
    });
  }

  channels(): Promise<KnownChannel[]> {
    return this.prisma.$transaction(async (tx) =>
      tx.channel.findMany({ orderBy: { firstSeen: 'asc' } }),
    );
  }

  channel(aa: string): Promise<KnownChannel | undefined> {
    return this.prisma.$transaction(
      async (tx) => (await tx.channel.findUnique({ where: { aa } })) ?? undefined,
    );
  }

  /** The voucher with the highest amount_spent for (aa, period), plus when the period started for us. */
  best(
    aa: string,
    period: number,
  ): Promise<(StoredVoucher & { firstReceivedAt: number }) | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.voucher.findMany({ where: { aa, period } });
      const top = rows.reduce<(typeof rows)[number] | undefined>(
        (best, r) =>
          best === undefined || BigInt(r.amountSpent) > BigInt(best.amountSpent) ? r : best,
        undefined,
      );
      if (top === undefined) return undefined;
      return {
        seq: top.seq,
        aa,
        period,
        amountSpent: BigInt(top.amountSpent),
        packageJson: top.packageJson,
        receivedAt: top.receivedAt,
        firstReceivedAt: Math.min(...rows.map((r) => r.receivedAt)),
      };
    });
  }

  action(aa: string, period: number, kind: ActionKind): Promise<ActionRow | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.action.findUnique({ where: { aa_period_kind: { aa, period, kind } } });
      return row === null
        ? undefined
        : {
            aa,
            period,
            kind,
            unit: row.unit,
            status: row.status as ActionRow['status'],
            updatedAt: row.updatedAt,
          };
    });
  }

  recordAction(a: {
    aa: string;
    period: number;
    kind: ActionKind;
    unit: string | null;
    status: ActionRow['status'];
    error?: string;
  }): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const ts = this.now();
      await tx.action.upsert({
        where: { aa_period_kind: { aa: a.aa, period: a.period, kind: a.kind } },
        create: { ...a, error: a.error ?? null, createdAt: ts, updatedAt: ts },
        update: { unit: a.unit, status: a.status, error: a.error ?? null, updatedAt: ts },
      });
    });
  }

  /** Channels with a seller close announced or in flight (reported to the facilitator). */
  closingChannels(): Promise<string[]> {
    return this.prisma.$transaction(async (tx) =>
      (
        await tx.action.findMany({
          where: { kind: 'close', status: { in: CLOSE_IN_PROGRESS } },
          select: { aa: true },
        })
      ).map((r) => r.aa),
    );
  }

  /** Marks the closes of earlier periods done: the channel accepts vouchers again. */
  finishCloses(aa: string, currentPeriod: number): Promise<number> {
    return this.prisma.$transaction(
      async (tx) =>
        (
          await tx.action.updateMany({
            where: {
              aa,
              kind: 'close',
              period: { lt: currentPeriod },
              status: { in: CLOSE_IN_PROGRESS },
            },
            data: { status: 'done', updatedAt: this.now() },
          })
        ).count,
    );
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
