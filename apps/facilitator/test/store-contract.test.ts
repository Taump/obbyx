import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppendInput,
  type BatchStore,
  type SettlementStore,
  SqliteBatchStore,
  SqliteSettlementStore,
  StoreLockedError,
} from '@obbyx/x402-obyte';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedSqliteFile } from '../../../packages/obyte/test/helpers.js';
import { SchemaNotMigratedError, openDatabase } from '../src/storage/database.js';
import { PrismaBatchStore } from '../src/storage/batch-store.js';
import { PackageCipher } from '../src/storage/package-cipher.js';
import { PrismaSettlementStore } from '../src/storage/settlement-store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Impl {
  name: string;
  make(): Promise<{ settlements: SettlementStore; batch: BatchStore }>;
}

const IMPLS: Impl[] = [
  {
    name: 'node:sqlite',
    async make() {
      const settlements = new SqliteSettlementStore(':memory:');
      cleanups.push(() => settlements.close());
      return { settlements, batch: new SqliteBatchStore(settlements.database) };
    },
  },
  {
    name: 'prisma',
    async make() {
      const prisma = await openDatabase(
        migratedSqliteFile(new URL('../prisma/migrations/', import.meta.url), 'facilitator.db'),
      );
      cleanups.push(() => prisma.$disconnect());
      return {
        settlements: new PrismaSettlementStore(prisma),
        batch: new PrismaBatchStore(prisma, PackageCipher.fromKey(randomBytes(32))),
      };
    },
  },
];

const settlement = (key: string) => ({
  key,
  network: 'obyte:testnet',
  unitHash: key,
  binding: 'b'.repeat(64),
  payer: 'P'.repeat(32),
  payTo: 'S'.repeat(32),
  asset: 'base',
  amount: '20000',
  unitJson: '{}',
  publishDeadline: 9_999_999_999,
});

const OWNER = { payTo: 'S'.repeat(32), network: 'obyte:testnet' };

const voucher = (amountSpent: bigint, hash: string, period = 1): AppendInput => ({
  channelKey: 'obyte:testnet:aa:X',
  network: 'obyte:testnet',
  aa: 'X'.repeat(32),
  payTo: 'S'.repeat(32),
  payer: 'P'.repeat(32),
  asset: 'base',
  period,
  amountSpent,
  paymentAmount: 100n,
  binding: 'b'.repeat(64),
  packageHash: hash,
  packageJson: '{}',
});

describe.each(IMPLS)('SettlementStore contract — $name', (impl) => {
  it('claims a key exactly once under concurrency', async () => {
    const { settlements } = await impl.make();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => settlements.claim(settlement('k1'))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.record.state === 'claimed')).toBe(true);
  });

  it('transitions are compare-and-set: one winner, wrong source state refused', async () => {
    const { settlements } = await impl.make();
    await settlements.claim(settlement('k2'));
    const moves = await Promise.all(
      Array.from({ length: 8 }, () => settlements.transition('k2', ['claimed'], 'broadcasting')),
    );
    expect(moves.filter((m) => m !== undefined)).toHaveLength(1);
    expect(await settlements.transition('k2', ['claimed'], 'accepted')).toBeUndefined();
    const accepted = await settlements.transition('k2', ['broadcasting'], 'accepted', {
      incrementAttempts: true,
      lastError: null,
      data: { via: 'test' },
    });
    expect(accepted).toMatchObject({ state: 'accepted', attempts: 1 });
    const kinds = (await settlements.events('k2')).map((e) => `${e.kind}:${e.to}`);
    expect(kinds).toEqual(['claimed:claimed', 'transition:broadcasting', 'transition:accepted']);
  });

  it('lists only active settlements and prunes terminal unit bodies', async () => {
    const { settlements } = await impl.make();
    await settlements.claim(settlement('a'));
    await settlements.claim(settlement('t'));
    await settlements.transition('t', ['claimed'], 'expired');
    expect((await settlements.listActive()).map((r) => r.key)).toEqual(['a']);
    expect(await settlements.pruneUnitBodies(9_999_999_999)).toBe(1);
    expect((await settlements.get('t'))?.unitJson).toBeNull();
    expect((await settlements.get('a'))?.unitJson).toBe('{}');
  });
});

describe.each(IMPLS)('BatchStore contract — $name', (impl) => {
  it('enforces committed + price, one in-flight voucher, and commit releases the channel', async () => {
    const { batch } = await impl.make();
    const first = await batch.appendPending(voucher(100n, 'h1'));
    expect(first.ok).toBe(true);
    expect(await batch.appendPending(voucher(200n, 'h2'))).toMatchObject({
      ok: false,
      reason: 'channel_busy',
    });
    if (!first.ok) return;
    expect(await batch.commit(first.commitment.seq, OWNER)).toMatchObject({ state: 'committed' });
    expect(await batch.commit(first.commitment.seq, OWNER)).toMatchObject({ state: 'committed' }); // idempotent
    expect((await batch.channel('obyte:testnet:aa:X'))?.committed).toBe(100n);
    expect(await batch.appendPending(voucher(300n, 'h3'))).toMatchObject({
      ok: false,
      reason: 'cumulative_amount_mismatch',
      committed: 100n,
    });
    expect((await batch.appendPending(voucher(200n, 'h4'))).ok).toBe(true);
  });

  it("commit refuses another seller's or another network's voucher (no IDOR via ack)", async () => {
    const { batch } = await impl.make();
    const a = await batch.appendPending(voucher(100n, 'x1'));
    if (!a.ok) throw new Error('append failed');
    expect(
      await batch.commit(a.commitment.seq, { payTo: 'Q'.repeat(32), network: 'obyte:testnet' }),
    ).toBeUndefined();
    expect(
      await batch.commit(a.commitment.seq, { payTo: 'S'.repeat(32), network: 'obyte:livenet' }),
    ).toBeUndefined();
    expect((await batch.commitment(a.commitment.seq))?.state).toBe('pending');
    expect((await batch.channel('obyte:testnet:aa:X'))?.pendingSeq).toBe(a.commitment.seq);
  });

  it('only one of many concurrent vouchers is accepted', async () => {
    const { batch } = await impl.make();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => batch.appendPending(voucher(100n, `c${i}`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a new period resets the committed amount; the journal is ordered by seq per seller', async () => {
    const { batch } = await impl.make();
    const a = await batch.appendPending(voucher(100n, 'p1'));
    if (a.ok) await batch.commit(a.commitment.seq, OWNER);
    const b = await batch.appendPending(voucher(100n, 'p2', 2));
    expect(b.ok).toBe(true);
    const journal = await batch.journal('S'.repeat(32), 0);
    expect(journal.map((c) => [c.period, c.state])).toEqual([
      [1, 'committed'],
      [2, 'pending'],
    ]);
    expect(await batch.journal('S'.repeat(32), journal[0]!.seq)).toHaveLength(1);
    expect((await batch.commitmentByHash('p2'))?.amountSpent).toBe(100n);
  });
});

describe('Prisma database', () => {
  it('a second facilitator process cannot open the same database file', async () => {
    const file = migratedSqliteFile(
      new URL('../prisma/migrations/', import.meta.url),
      'facilitator.db',
    );
    const first = await openDatabase(file);
    cleanups.push(() => first.$disconnect());
    await expect(openDatabase(file)).rejects.toBeInstanceOf(StoreLockedError);
  });

  it('refuses an unmigrated database with a clear instruction', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'obbyx-prisma-')), 'empty.db');
    await expect(openDatabase(file)).rejects.toBeInstanceOf(SchemaNotMigratedError);
  });
});

describe('channel packages at rest (Prisma store)', () => {
  it('are encrypted in the database and every read is journaled', async () => {
    const file = migratedSqliteFile(
      new URL('../prisma/migrations/', import.meta.url),
      'facilitator.db',
    );
    const prisma = await openDatabase(file);
    cleanups.push(() => prisma.$disconnect());
    const batch = new PrismaBatchStore(prisma, PackageCipher.fromKey(randomBytes(32)));
    const input = voucher(100n, 'secret-hash');
    const res = await batch.appendPending(input);
    if (!res.ok) throw new Error('append failed');
    expect(res.commitment.packageJson).toBe(input.packageJson);

    const raw = await prisma.batchCommitment.findUnique({ where: { seq: res.commitment.seq } });
    expect(raw?.packageJson.startsWith('enc:v1:')).toBe(true);
    expect(raw?.packageJson).not.toContain(input.packageJson);

    expect((await batch.commitment(res.commitment.seq))?.packageJson).toBe(input.packageJson);
    expect(await batch.journal(input.payTo, 0)).toHaveLength(1);
    const reads = await prisma.event.findMany({ where: { kind: 'package_read' } });
    expect(reads.map((e) => JSON.parse(e.data ?? '{}').op)).toEqual(['by_seq', 'journal']);
    expect(reads.every((e) => !(e.data ?? '').includes(input.packageJson))).toBe(true);
  });

  it('a different key cannot read them (fail closed)', async () => {
    const file = migratedSqliteFile(
      new URL('../prisma/migrations/', import.meta.url),
      'facilitator.db',
    );
    const prisma = await openDatabase(file);
    cleanups.push(() => prisma.$disconnect());
    const res = await new PrismaBatchStore(
      prisma,
      PackageCipher.fromKey(randomBytes(32)),
    ).appendPending(voucher(100n, 'k1'));
    if (!res.ok) throw new Error('append failed');
    const other = new PrismaBatchStore(prisma, PackageCipher.fromKey(randomBytes(32)));
    await expect(other.commitment(res.commitment.seq)).rejects.toThrow(/Cannot decrypt/);
  });
});

describe('PackageCipher', () => {
  it('binds a ciphertext to its package hash', () => {
    const c = PackageCipher.fromKey(randomBytes(32));
    const enc = c.encrypt('{"a":1}', 'h1');
    expect(c.decrypt(enc, 'h1')).toBe('{"a":1}');
    expect(() => c.decrypt(enc, 'h2')).toThrow(/Cannot decrypt/);
    expect(() => c.decrypt('{"a":1}', 'h1')).toThrow(/not encrypted/);
  });

  it('creates the key file with mode 0600 and refuses a group-readable one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obbyx-key-'));
    const path = join(dir, 'package.key');
    const a = PackageCipher.fromFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const b = PackageCipher.fromFile(path); // same key on restart
    expect(b.decrypt(a.encrypt('x', 'h'), 'h')).toBe('x');
    chmodSync(path, 0o644);
    expect(() => PackageCipher.fromFile(path)).toThrow(/chmod 600/);
  });
});
