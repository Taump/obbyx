import type {
  NewSettlement,
  SettlementEvent,
  SettlementRecord,
  SettlementState,
  SettlementStore,
  TransitionPatch,
} from '@obbyx/x402-obyte';
import type { ExactSettlement, PrismaClient } from '../generated/prisma/client.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const ACTIVE: SettlementState[] = ['claimed', 'broadcasting', 'accepted'];
const TERMINAL: SettlementState[] = ['stable_good', 'final_bad', 'rejected', 'expired'];

/**
 * Prisma implementation of the `exact` SettlementStore port. Every operation
 * runs in its own transaction (see database.ts); transitions are
 * compare-and-set via `updateMany({ where: { key, state } })`.
 */
export class PrismaSettlementStore implements SettlementStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get(key: string): Promise<SettlementRecord | undefined> {
    return this.prisma.$transaction(async (tx) => find(tx, key));
  }

  claim(input: NewSettlement): Promise<{ created: boolean; record: SettlementRecord }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await find(tx, input.key);
      if (existing !== undefined) return { created: false, record: existing };
      const ts = this.now();
      const row = await tx.exactSettlement.create({
        data: { ...input, state: 'claimed', attempts: 0, createdAt: ts, updatedAt: ts },
      });
      await tx.event.create({ data: { ts, key: input.key, kind: 'claimed', toState: 'claimed' } });
      return { created: true, record: toRecord(row) };
    });
  }

  transition(
    key: string,
    from: readonly SettlementState[],
    to: SettlementState,
    patch: TransitionPatch = {},
  ): Promise<SettlementRecord | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const current = await find(tx, key);
      if (current === undefined || !from.includes(current.state)) return undefined;
      const ts = this.now();
      const updated = await tx.exactSettlement.updateMany({
        where: { key, state: current.state },
        data: {
          state: to,
          updatedAt: ts,
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.incrementAttempts === true ? { attempts: { increment: 1 } } : {}),
        },
      });
      if (updated.count !== 1) return undefined;
      await tx.event.create({
        data: {
          ts,
          key,
          kind: 'transition',
          fromState: current.state,
          toState: to,
          ...(patch.data ? { data: JSON.stringify(patch.data) } : {}),
        },
      });
      return find(tx, key);
    });
  }

  async event(event: SettlementEvent): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.event.create({
        data: {
          ts: this.now(),
          key: event.key,
          kind: event.kind,
          fromState: event.from ?? null,
          toState: event.to ?? null,
          data: event.data === undefined ? null : JSON.stringify(event.data),
        },
      });
    });
  }

  touch(key: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.exactSettlement.updateMany({ where: { key }, data: { updatedAt: this.now() } });
    });
  }

  listActive(limit = 100): Promise<SettlementRecord[]> {
    return this.prisma.$transaction(async (tx) =>
      (
        await tx.exactSettlement.findMany({
          where: { state: { in: ACTIVE } },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        })
      ).map(toRecord),
    );
  }

  events(
    key: string,
  ): Promise<{ kind: string; from: string | null; to: string | null; data: unknown }[]> {
    return this.prisma.$transaction(async (tx) =>
      (await tx.event.findMany({ where: { key }, orderBy: { id: 'asc' } })).map((e) => ({
        kind: e.kind,
        from: e.fromState,
        to: e.toState,
        data: e.data === null ? null : (JSON.parse(e.data) as unknown),
      })),
    );
  }

  pruneUnitBodies(olderThan: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.exactSettlement.updateMany({
        where: { unitJson: { not: null }, updatedAt: { lt: olderThan }, state: { in: TERMINAL } },
        data: { unitJson: null },
      });
      return res.count;
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

async function find(tx: Tx, key: string): Promise<SettlementRecord | undefined> {
  const row = await tx.exactSettlement.findUnique({ where: { key } });
  return row === null ? undefined : toRecord(row);
}

function toRecord(row: ExactSettlement): SettlementRecord {
  return {
    key: row.key,
    network: row.network,
    unitHash: row.unitHash,
    binding: row.binding,
    payer: row.payer,
    payTo: row.payTo,
    asset: row.asset,
    amount: row.amount,
    state: row.state as SettlementState,
    unitJson: row.unitJson,
    publishDeadline: row.publishDeadline,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
