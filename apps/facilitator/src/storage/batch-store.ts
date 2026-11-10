import {
  type AppendInput,
  type AppendResult,
  type BatchStore,
  type ChannelRow,
  type CommitmentOwner,
  type CommitmentRow,
  type CommitmentState,
  ownedBy,
} from '@obbyx/x402-obyte';
import type { BatchChannel, BatchCommitment, PrismaClient } from '../generated/prisma/client.js';
import { ObbyxError } from '@obbyx/obyte';
import type { Logger } from '@obbyx/obyte/logger';
import { PackageCipher } from './package-cipher.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
type CommitmentMeta = Omit<CommitmentRow, 'packageJson'>;

/**
 * Prisma implementation of the batch-settlement BatchStore port (same rules as
 * SqliteBatchStore). Client-signed packages are encrypted at rest with
 * {@link PackageCipher}, and every read of a package is recorded in the
 * `events` table (`package_read`, ADR-0001). Lookups that need no package
 * (`commitmentMeta`, `commit`, `cancel`) never decrypt one.
 */
export class PrismaBatchStore implements BatchStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: PackageCipher,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly log?: Logger,
  ) {}

  /**
   * The store with the key from `keyFile`, for startup. A key file is created
   * only while the database holds no package; with stored packages a missing
   * file or a key that decrypts none of the newest packages is refused (a new
   * key would make every stored voucher undecryptable).
   */
  static async open(
    prisma: PrismaClient,
    keyFile: string,
    log?: Logger,
  ): Promise<PrismaBatchStore> {
    const empty = (await prisma.batchCommitment.findFirst({ select: { seq: true } })) === null;
    const cipher = PackageCipher.fromFile(keyFile, { create: empty });
    const store = new PrismaBatchStore(prisma, cipher, undefined, log);
    if (!empty) await store.assertKeyMatches();
    return store;
  }

  /**
   * Decrypts one of the newest packages (journaled like any read). Several are
   * tried: AES-GCM cannot tell a damaged row from a wrong key, and one damaged
   * row must not block startup.
   */
  private async assertKeyMatches(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.batchCommitment.findMany({ orderBy: { seq: 'desc' }, take: 5 });
      for (const row of rows) {
        try {
          await this.one(tx, row, 'key_check');
          return;
        } catch {
          // try the next one
        }
      }
      throw new ObbyxError(
        'invalid_config',
        `PACKAGE_KEY_FILE decrypts none of the ${rows.length} newest stored channel packages: it is not the key they were encrypted with. Restore the original key file.`,
      );
    });
  }

  /**
   * Decrypts rows and journals the access in the same transaction. With
   * `skipDamaged` (replay lists) a row that cannot be decrypted is logged,
   * journaled as `package_unreadable` and skipped, so it does not block the
   * seller's other vouchers; otherwise it throws.
   */
  private async open(
    tx: Tx,
    rows: BatchCommitment[],
    op: string,
    skipDamaged = false,
  ): Promise<CommitmentRow[]> {
    const ts = this.now();
    const opened: CommitmentRow[] = [];
    const events = [];
    for (const r of rows) {
      const data = JSON.stringify({
        op,
        seq: r.seq,
        package: `sha256:${r.packageHash.slice(0, 16)}`,
      });
      try {
        opened.push(toCommitment(r, this.cipher.decrypt(r.packageJson, r.packageHash)));
        events.push({ ts, key: r.channelKey, kind: 'package_read', data });
      } catch (err) {
        if (!skipDamaged) throw err;
        this.log?.error(
          { err, seq: r.seq, op },
          'stored channel package cannot be decrypted; skipped',
        );
        events.push({ ts, key: r.channelKey, kind: 'package_unreadable', data });
      }
    }
    if (events.length > 0) await tx.event.createMany({ data: events });
    return opened;
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

  async commitmentMeta(packageHash: string): Promise<CommitmentMeta | undefined> {
    const row = await this.prisma.batchCommitment.findUnique({
      where: { packageHash },
      omit: { packageJson: true },
    });
    return row === null ? undefined : toMeta(row);
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
        true,
      ),
    );
  }

  journal(payTo: string, cursor: number, limit = 500): Promise<CommitmentRow[]> {
    return this.prisma.$transaction(async (tx) =>
      this.open(
        tx,
        await tx.batchCommitment.findMany({
          where: { payTo, seq: { gt: cursor }, state: { not: 'cancelled' } },
          orderBy: { seq: 'asc' },
          take: limit,
        }),
        'journal',
        true,
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

  commit(seq: number, owner: CommitmentOwner): Promise<CommitmentMeta | undefined> {
    return this.settle(seq, owner, 'committed');
  }

  cancel(seq: number, owner: CommitmentOwner): Promise<CommitmentMeta | undefined> {
    return this.settle(seq, owner, 'cancelled');
  }

  /** Same rules as SqliteBatchStore.settle. */
  private settle(
    seq: number,
    owner: CommitmentOwner,
    to: 'committed' | 'cancelled',
  ): Promise<CommitmentMeta | undefined> {
    return this.prisma.$transaction(async (tx) => {
      // Plaintext columns only: settling an entry is not a package read.
      const row = await tx.batchCommitment.findUnique({
        where: { seq },
        omit: { packageJson: true },
      });
      if (row === null || !ownedBy(row, owner)) return undefined;
      const c = toMeta(row);
      if (c.state !== 'pending') return c;
      const ts = this.now();
      if (to === 'committed') {
        await tx.batchCommitment.update({
          where: { seq },
          data: { state: 'committed', committedAt: ts },
        });
        await tx.batchChannel.updateMany({
          where: { key: c.channelKey, pendingSeq: seq, period: c.period },
          data: { committed: c.amountSpent.toString(), pendingSeq: null, updatedAt: ts },
        });
      } else {
        await tx.batchCommitment.update({ where: { seq }, data: { state: 'cancelled' } });
        await tx.batchChannel.updateMany({
          where: { key: c.channelKey, pendingSeq: seq },
          data: { pendingSeq: null, updatedAt: ts },
        });
      }
      return { ...c, state: to };
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
  return { ...toMeta(r), packageJson };
}

function toMeta(r: Omit<BatchCommitment, 'packageJson'>): CommitmentMeta {
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
    state: r.state as CommitmentState,
  };
}
