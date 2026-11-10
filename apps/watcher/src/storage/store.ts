import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { ObbyxError, getNetwork, verifyVoucherPackage } from '@obbyx/obyte';
import { StoreLockedError } from '@obbyx/x402-obyte';
import { PrismaClient } from '../generated/prisma/client.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

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

/** Best voucher of a period, plus when the period's first voucher was received. */
export type BestStored = StoredVoucher & { firstReceivedAt: number };

/** A stored voucher the AA would reject. */
export interface InvalidVoucher {
  readonly seq: number;
  readonly aa: string;
  readonly period: number;
  readonly reason: string;
}

export interface KnownChannel {
  readonly aa: string;
  readonly network: string;
  readonly payer: string;
  readonly asset: string;
  readonly timeout: number;
}

export type ActionKind = 'close' | 'confirm' | 'fraud_proof';

/** Outcome of storing a voucher: only `stored` and `duplicate` may be acked. */
export type SaveResult =
  | { readonly kind: 'stored' }
  | { readonly kind: 'duplicate' }
  /** The seq is taken by ANOTHER voucher (e.g. the facilitator's journal was reset). */
  | { readonly kind: 'seq_conflict' }
  | { readonly kind: 'not_increasing'; readonly best: bigint }
  /** A confirm / our sent close of the period: the voucher could never reach the chain. */
  | { readonly kind: 'settling'; readonly action: ActionKind; readonly status: string };

export interface ActionRow {
  readonly aa: string;
  readonly period: number;
  readonly kind: ActionKind;
  readonly unit: string | null;
  /**
   * announced: a close is decided and the facilitator told to accept no new
   * vouchers for the channel; sent: the trigger is (being) broadcast; done:
   * the channel moved to a later period; failed: the trigger was not sent.
   */
  readonly status: 'announced' | 'sent' | 'done' | 'failed';
  readonly updatedAt: number;
  /**
   * Units that could have landed for this row (posted, or outcome unknown);
   * units the hub definitely refused do not count.
   */
  readonly attempts: number;
  /** Seq of the voucher the last close / fraud_proof carried (null: none known). */
  readonly voucherSeq: number | null;
}

interface RecordAction {
  readonly kind: ActionKind;
  readonly unit: string | null;
  readonly status: ActionRow['status'];
  readonly error?: string;
  readonly voucherSeq?: number | null;
  /** +1: one more unit (possibly) broadcast; -1: the hub definitely refused it. */
  readonly attempt?: 1 | -1;
}

/** One channel period inside ONE transaction (see {@link WatcherStore.atomically}). */
export interface ChannelPeriodView {
  best(): Promise<BestStored | undefined>;
  action(kind: ActionKind): Promise<ActionRow | undefined>;
  record(a: RecordAction): Promise<void>;
}

/** Close states that make a channel "closing" for the facilitator. */
const CLOSE_IN_PROGRESS = ['announced', 'sent'];
/** Rows checked per transaction by the startup pass. */
const VERIFY_CHUNK = 500;

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
   * Durably stores a voucher and its channel. The caller (the link) verified
   * the package with the AA profile. Returns only after the SQLite
   * transaction committed (synchronous = FULL): the caller may then ack.
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
    /** The chain shows a client close of this period: our own close lost the race. */
    clientClosing?: boolean;
  }): Promise<SaveResult> {
    return this.prisma.$transaction(async (tx): Promise<SaveResult> => {
      const ts = this.now();
      await tx.channel.upsert({
        where: { aa: v.aa },
        create: { ...v.channel, firstSeen: ts },
        update: {},
      });
      // This exact package is already ours (under any seq, e.g. the envelope's
      // seq was altered in transit): acking it again is true. Checked first.
      const same = await tx.voucher.findFirst({
        where: { aa: v.aa, period: v.period, packageJson: v.packageJson },
        select: { seq: true },
      });
      if (same !== null) return { kind: 'duplicate' };
      // The seq holds ANOTHER package: acking would confirm one we never stored.
      if ((await tx.voucher.findUnique({ where: { seq: v.seq }, select: { seq: true } })) !== null)
        return { kind: 'seq_conflict' };
      // Once a confirm (any status but failed) or our sent close is recorded,
      // a new voucher can never reach the chain. The defender records those
      // in a transaction that also reads the best voucher (`atomically`), so
      // a voucher is either seen by that decision or refused here. Our close
      // does not block when the chain shows a client close: ours lost the
      // race and the voucher may enable a fraud proof.
      const blocking = await tx.action.findFirst({
        where: {
          aa: v.aa,
          period: v.period,
          OR: [
            { kind: 'confirm', status: { not: 'failed' } },
            ...(v.clientClosing === true
              ? []
              : [{ kind: 'close', status: { in: ['sent', 'done'] } }]),
          ],
        },
      });
      if (blocking !== null) {
        return { kind: 'settling', action: blocking.kind as ActionKind, status: blocking.status };
      }
      // A NEW journal entry must raise the channel's cumulative amount: one
      // that does not (e.g. the same amount reused through a second
      // facilitator) would serve a request nobody pays for.
      // Vouchers known to be invalid do not count (they can never be cashed).
      const top = await tx.voucher.findFirst({
        where: { aa: v.aa, period: v.period, OR: [{ verified: true }, { verified: null }] },
        orderBy: { amountSpent: 'desc' },
        select: { amountSpent: true },
      });
      if (top !== null && v.amountSpent <= top.amountSpent) {
        return { kind: 'not_increasing', best: top.amountSpent };
      }
      await tx.voucher.create({
        data: {
          seq: v.seq,
          network: v.network,
          aa: v.aa,
          period: v.period,
          amountSpent: v.amountSpent,
          paymentAmount: v.paymentAmount.toString(),
          binding: v.binding,
          packageJson: v.packageJson,
          receivedAt: ts,
          verified: true,
        },
      });
      return { kind: 'stored' };
    });
  }

  /** Whether this exact package is already stored for (aa, period). */
  hasVoucher(aa: string, period: number, packageJson: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) =>
        (await tx.voucher.findFirst({
          where: { aa, period, packageJson },
          select: { seq: true },
        })) !== null,
    );
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

  /** The verified voucher with the highest amount_spent for (aa, period). */
  best(aa: string, period: number): Promise<BestStored | undefined> {
    return this.prisma.$transaction((tx) => bestIn(tx, aa, period));
  }

  /**
   * Our hub reports that the AA rejected this voucher. It is marked invalid
   * (never carried again) only if it also fails the AA profile locally: one
   * hub's word must not discard a voucher that defends the seller. Returns
   * why it is invalid, or undefined when it passes locally (kept).
   */
  rejectVoucher(seq: number): Promise<string | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.voucher.findUniqueOrThrow({ where: { seq } });
      const channel = await tx.channel.findUnique({ where: { aa: row.aa } });
      const reason = voucherProblem(row, channel?.payer);
      if (reason !== undefined)
        await tx.voucher.update({ where: { seq }, data: { verified: false } });
      return reason;
    });
  }

  /**
   * Startup pass: checks once, with the AA profile, the vouchers stored
   * before that check (`verified` null) and returns the ones that fail.
   * Chunks of {@link VERIFY_CHUNK} rows, each in its own short transaction.
   */
  async verifyStoredVouchers(): Promise<InvalidVoucher[]> {
    const invalid: InvalidVoucher[] = [];
    for (;;) {
      const found = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.voucher.findMany({ where: { verified: null }, take: VERIFY_CHUNK });
        const aas = [...new Set(rows.map((r) => r.aa))];
        const payers = new Map(
          (await tx.channel.findMany({ where: { aa: { in: aas } } })).map((c) => [c.aa, c.payer]),
        );
        const bad = new Set<number>();
        for (const row of rows) {
          const reason = voucherProblem(row, payers.get(row.aa));
          if (reason === undefined) continue;
          bad.add(row.seq);
          invalid.push({ seq: row.seq, aa: row.aa, period: row.period, reason });
        }
        const seqs = rows.map((r) => r.seq);
        await tx.voucher.updateMany({
          where: { seq: { in: seqs.filter((s) => !bad.has(s)) } },
          data: { verified: true },
        });
        await tx.voucher.updateMany({
          where: { seq: { in: [...bad] } },
          data: { verified: false },
        });
        return rows.length;
      });
      if (found < VERIFY_CHUNK) return invalid;
    }
  }

  action(aa: string, period: number, kind: ActionKind): Promise<ActionRow | undefined> {
    return this.prisma.$transaction((tx) => actionIn(tx, aa, period, kind));
  }

  recordAction(a: RecordAction & { aa: string; period: number }): Promise<void> {
    return this.prisma.$transaction((tx) => recordIn(tx, a.aa, a.period, a, this.now()));
  }

  /**
   * Runs `fn` in ONE transaction over (aa, period): the best voucher it reads
   * and the action it records are atomic with respect to `saveVoucher`. `fn`
   * must not wait on the network (the database has a single connection).
   */
  atomically<T>(
    aa: string,
    period: number,
    fn: (view: ChannelPeriodView) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) =>
      fn({
        best: () => bestIn(tx, aa, period),
        action: (kind) => actionIn(tx, aa, period, kind),
        record: (a) => recordIn(tx, aa, period, a, this.now()),
      }),
    );
  }

  /** Records a client close of (aa, period); true the first time it is seen. */
  noteClientClose(aa: string, period: number): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) =>
        (
          await tx.channel.updateMany({
            where: {
              aa,
              OR: [{ clientClosePeriod: null }, { clientClosePeriod: { not: period } }],
            },
            data: { clientClosePeriod: period },
          })
        ).count > 0,
    );
  }

  /**
   * Channels reported "closing" to the facilitator (no new vouchers): a seller
   * close announced or in flight, or a client close in progress.
   */
  closingChannels(): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const ours = await tx.action.findMany({
        where: { kind: 'close', status: { in: CLOSE_IN_PROGRESS } },
        select: { aa: true },
      });
      const theirs = await tx.channel.findMany({
        where: { clientClosePeriod: { not: null } },
        select: { aa: true },
      });
      return [...new Set([...ours, ...theirs].map((r) => r.aa))];
    });
  }

  /**
   * Ends the closes (ours and the client's) of earlier periods: the channel
   * accepts vouchers again. Returns how many were ended.
   */
  finishCloses(aa: string, currentPeriod: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const ours = await tx.action.updateMany({
        where: {
          aa,
          kind: 'close',
          period: { lt: currentPeriod },
          status: { in: CLOSE_IN_PROGRESS },
        },
        data: { status: 'done', updatedAt: this.now() },
      });
      const theirs = await tx.channel.updateMany({
        where: { aa, clientClosePeriod: { lt: currentPeriod } },
        data: { clientClosePeriod: null },
      });
      return ours.count + theirs.count;
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Only verified vouchers are candidates: a trigger never carries one the AA rejects. */
async function bestIn(tx: Tx, aa: string, period: number): Promise<BestStored | undefined> {
  const where = { aa, period, verified: true };
  const top = await tx.voucher.findFirst({ where, orderBy: { amountSpent: 'desc' } });
  if (top === null) return undefined;
  // saveVoucher stores only increasing amounts: the lowest is the first received.
  const first = await tx.voucher.findFirst({
    where,
    orderBy: { amountSpent: 'asc' },
    select: { receivedAt: true },
  });
  return {
    seq: top.seq,
    aa,
    period,
    amountSpent: top.amountSpent,
    packageJson: top.packageJson,
    receivedAt: top.receivedAt,
    firstReceivedAt: first?.receivedAt ?? top.receivedAt,
  };
}

/** Why a stored voucher would be rejected by the AA (undefined: it would not). */
function voucherProblem(
  row: { aa: string; period: number; network: string; amountSpent: bigint; packageJson: string },
  payer: string | undefined,
): string | undefined {
  let network: ReturnType<typeof getNetwork>;
  let pkg: unknown;
  try {
    network = getNetwork(row.network);
    pkg = JSON.parse(row.packageJson);
  } catch (err) {
    return `unreadable voucher: ${err instanceof Error ? err.message : String(err)}`;
  }
  const v = verifyVoucherPackage<Record<string, unknown> | null>(pkg, {
    network,
    ...(payer === undefined ? {} : { expectedSigner: payer }),
  });
  if (!v.ok) return `fails the AA profile: ${v.message}`;
  const m = v.value.message;
  if (
    m?.['aa_address'] !== row.aa ||
    m['period'] !== row.period ||
    String(m['amount_spent']) !== row.amountSpent.toString()
  ) {
    return 'signed message does not match the stored voucher';
  }
  return undefined;
}

async function actionIn(
  tx: Tx,
  aa: string,
  period: number,
  kind: ActionKind,
): Promise<ActionRow | undefined> {
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
        attempts: row.attempts,
        voucherSeq: row.voucherSeq,
      };
}

async function recordIn(
  tx: Tx,
  aa: string,
  period: number,
  a: RecordAction,
  ts: number,
): Promise<void> {
  const data = {
    unit: a.unit,
    status: a.status,
    error: a.error ?? null,
    updatedAt: ts,
    ...(a.voucherSeq === undefined ? {} : { voucherSeq: a.voucherSeq }),
  };
  await tx.action.upsert({
    where: { aa_period_kind: { aa, period, kind: a.kind } },
    create: {
      ...data,
      aa,
      period,
      kind: a.kind,
      attempts: Math.max(0, a.attempt ?? 0),
      createdAt: ts,
    },
    update: { ...data, attempts: { increment: a.attempt ?? 0 } },
  });
}
