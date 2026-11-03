import type {
  AppendInput,
  AppendResult,
  BatchStore,
  ChannelRow,
  CommitmentRow,
  CommitmentState,
} from '@obbyx/x402-obyte';
import type { BatchChannel, BatchCommitment, PrismaClient } from '../generated/prisma/client.js';
import type { PackageCipher } from './package-cipher.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Prisma implementation of the batch-settlement BatchStore port (same rules as
 * SqliteBatchStore). Client-signed packages are encrypted at rest with
 * {@link PackageCipher}, and every read of a package is recorded in the
 * `events` table (`package_read`, ADR-0001).
 */
export class PrismaBatchStore implements BatchStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: PackageCipher,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Decrypts rows and journals the access in the same transaction. */
  private async open(tx: Tx, rows: BatchCommitment[], op: string): Promise<CommitmentRow[]> {
    if (rows.length === 0) return [];
    const ts = this.now();
    await tx.event.createMany({
      data: rows.map((r) => ({
        ts,
        key: r.channelKey,
        kind: 'package_read',
        data: JSON.stringify({ op, seq: r.seq, package: `sha256:${r.packageHash.slice(0, 16)}` }),
      })),
    });
    return rows.map((r) => toCommitment(r, this.cipher.decrypt(r.packageJson, r.packageHash)));
  }

  private async one(
    tx: Tx,
    row: BatchCommitment | null,
    op: string,
  ): Promise<CommitmentRow | undefined> {
    return row === null ? undefined : (await this.open(tx, [row], op))[0];
  }

  channel(key: string): Promise<ChannelRow | undefined> {
    return this.prisma.$transaction(async (tx) => findChannel(tx, key));
  }

  commitmentByHash(packageHash: string): Promise<CommitmentRow | undefined> {
    return this.prisma.$transaction(async (tx) => {
      return this.one(
        tx,
        await tx.batchCommitment.findUnique({ where: { packageHash } }),
        'by_hash',
      );
    });
  }

  commitment(seq: number): Promise<CommitmentRow | undefined> {
    return this.prisma.$transaction(async (tx) =>
      this.one(tx, await tx.batchCommitment.findUnique({ where: { seq } }), 'by_seq'),
    );
  }

  pending(payTo: string): Promise<CommitmentRow[]> {
    return this.prisma.$transaction(async (tx) =>
      this.open(
        tx,
        await tx.batchCommitment.findMany({
          where: { payTo, state: 'pending' },
          orderBy: { seq: 'asc' },
        }),
        'pending_replay',
      ),
    );
  }

  journal(payTo: string, cursor: number, limit = 500): Promise<CommitmentRow[]> {
    return this.prisma.$transaction(async (tx) =>
      this.open(
        tx,
        await tx.batchCommitment.findMany({
          where: { payTo, seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
          take: limit,
        }),
        'journal',
      ),
    );
  }

  appendPending(input: AppendInput): Promise<AppendResult> {
    return this.prisma.$transaction(async (tx): Promise<AppendResult> => {
      const ts = this.now();
      let channel = await findChannel(tx, input.channelKey);
      if (channel === undefined || channel.period < input.period) {
        if (channel?.pendingSeq != null) {
          return { ok: false, reason: 'channel_busy', committed: channel.committed };
        }
        await tx.batchChannel.upsert({
          where: { key: input.channelKey },
          create: {
            key: input.channelKey,
            network: input.network,
            aa: input.aa,
            payTo: input.payTo,
            payer: input.payer,
            asset: input.asset,
            period: input.period,
            committed: '0',
            pendingSeq: null,
            updatedAt: ts,
          },
          update: { period: input.period, committed: '0', updatedAt: ts },
        });
        channel = await findChannel(tx, input.channelKey);
      }
      if (channel === undefined) throw new Error('channel row missing');
      if (channel.period !== input.period) {
        return { ok: false, reason: 'period_mismatch', committed: channel.committed };
      }
      if (channel.pendingSeq !== null) {
        return { ok: false, reason: 'channel_busy', committed: channel.committed };
      }
      if (input.amountSpent !== channel.committed + input.paymentAmount) {
        return { ok: false, reason: 'cumulative_amount_mismatch', committed: channel.committed };
      }
      const row = await tx.batchCommitment.create({
        data: {
          channelKey: input.channelKey,
          network: input.network,
          aa: input.aa,
          payTo: input.payTo,
          period: input.period,
          amountSpent: input.amountSpent.toString(),
          paymentAmount: input.paymentAmount.toString(),
          binding: input.binding,
          packageHash: input.packageHash,
          packageJson: this.cipher.encrypt(input.packageJson, input.packageHash),
          state: 'pending',
          createdAt: ts,
        },
      });
      await tx.batchChannel.update({
        where: { key: input.channelKey },
        data: { pendingSeq: row.seq, updatedAt: ts },
      });
      // The caller already holds the plaintext; no stored package is read here.
      return { ok: true, commitment: toCommitment(row, input.packageJson) };
    });
  }

  commit(
    seq: number,
    owner: { payTo: string; network: string },
  ): Promise<CommitmentRow | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.batchCommitment.findUnique({ where: { seq } });
      if (row === null || row.payTo !== owner.payTo || row.network !== owner.network)
        return undefined;
      const c = await this.one(tx, row, 'commit');
      if (c === undefined || c.state === 'committed') return c;
      const ts = this.now();
      await tx.batchCommitment.update({
        where: { seq },
        data: { state: 'committed', committedAt: ts },
      });
      await tx.batchChannel.updateMany({
        where: { key: c.channelKey, pendingSeq: seq, period: c.period },
        data: { committed: c.amountSpent.toString(), pendingSeq: null, updatedAt: ts },
      });
      return { ...c, state: 'committed' as const };
    });
  }
}

async function findChannel(tx: Tx, key: string): Promise<ChannelRow | undefined> {
  const row = await tx.batchChannel.findUnique({ where: { key } });
  return row === null ? undefined : toChannel(row);
}

function toChannel(r: BatchChannel): ChannelRow {
  return {
    key: r.key,
    network: r.network,
    aa: r.aa,
    payTo: r.payTo,
    payer: r.payer,
    asset: r.asset,
    period: r.period,
    committed: BigInt(r.committed),
    pendingSeq: r.pendingSeq,
  };
}

function toCommitment(r: BatchCommitment, packageJson: string): CommitmentRow {
  return {
    seq: r.seq,
    channelKey: r.channelKey,
    network: r.network,
    aa: r.aa,
    payTo: r.payTo,
    period: r.period,
    amountSpent: BigInt(r.amountSpent),
    paymentAmount: BigInt(r.paymentAmount),
    binding: r.binding,
    packageHash: r.packageHash,
    packageJson,
    state: r.state as CommitmentState,
  };
}
