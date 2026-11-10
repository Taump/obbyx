import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger } from '@obbyx/obyte/logger';
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

/** The watcher's signed receipt names the seller, the network and the exact package. */
const owner = (packageHash: string) => ({
  payTo: 'S'.repeat(32),
  network: 'obyte:testnet',
  packageHash,
});

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
    expect(await batch.commit(first.commitment.seq, owner('h1'))).toMatchObject({
      state: 'committed',
    });
    expect(await batch.commit(first.commitment.seq, owner('h1'))).toMatchObject({
      state: 'committed',
    }); // idempotent
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
      await batch.commit(a.commitment.seq, { ...owner('x1'), payTo: 'Q'.repeat(32) }),
    ).toBeUndefined();
    expect(
      await batch.commit(a.commitment.seq, { ...owner('x1'), network: 'obyte:livenet' }),
    ).toBeUndefined();
    // a receipt for another package (e.g. a reused seq) commits nothing
    expect(await batch.commit(a.commitment.seq, owner('other'))).toBeUndefined();
    expect(await batch.cancel(a.commitment.seq, owner('other'))).toBeUndefined();
    expect((await batch.commitment(a.commitment.seq))?.state).toBe('pending');
    expect((await batch.channel('obyte:testnet:aa:X'))?.pendingSeq).toBe(a.commitment.seq);
  });

  it('cancel frees the channel without committing; final states are never undone', async () => {
    const { batch } = await impl.make();
    const a = await batch.appendPending(voucher(100n, 'n1'));
    if (!a.ok) throw new Error('append failed');
    expect(await batch.cancel(a.commitment.seq, owner('n1'))).toMatchObject({ state: 'cancelled' });
    expect(await batch.commit(a.commitment.seq, owner('n1'))).toMatchObject({ state: 'cancelled' });
    expect(await batch.channel('obyte:testnet:aa:X')).toMatchObject({
      committed: 0n,
      pendingSeq: null,
    });
    expect(await batch.journal('S'.repeat(32), 0)).toHaveLength(0);
    expect(await batch.pending('S'.repeat(32))).toHaveLength(0);
    // the same cumulative amount can be paid again by a new voucher
    const b = await batch.appendPending(voucher(100n, 'n2'));
    if (!b.ok) throw new Error('append failed');
    expect(await batch.commit(b.commitment.seq, owner('n2'))).toMatchObject({ state: 'committed' });
    expect(await batch.cancel(b.commitment.seq, owner('n2'))).toMatchObject({ state: 'committed' });
    expect((await batch.channel('obyte:testnet:aa:X'))?.committed).toBe(100n);
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
    if (a.ok) await batch.commit(a.commitment.seq, owner('p1'));
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

  it('commitmentMeta: the entry of a package without its body', async () => {
    const { batch } = await impl.make();
    const a = await batch.appendPending(voucher(100n, 'm1'));
    if (!a.ok) throw new Error('append failed');
    const meta = await batch.commitmentMeta('m1');
    expect(meta).toMatchObject({ seq: a.commitment.seq, amountSpent: 100n, state: 'pending' });
    expect(meta).not.toHaveProperty('packageJson');
    expect(await batch.commitmentMeta('nope')).toBeUndefined();
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

  it('metadata lookups, commit and cancel decrypt nothing and journal no read', async () => {
    const prisma = await openDatabase(
      migratedSqliteFile(new URL('../prisma/migrations/', import.meta.url), 'facilitator.db'),
    );
    cleanups.push(() => prisma.$disconnect());
    // A key that cannot decrypt the packages: any decryption would throw.
    const batch = new PrismaBatchStore(prisma, PackageCipher.fromKey(randomBytes(32)));
    const blind = new PrismaBatchStore(prisma, PackageCipher.fromKey(randomBytes(32)));
    const a = await batch.appendPending(voucher(100n, 'r1'));
    if (!a.ok) throw new Error('append failed');
    expect((await blind.commitmentMeta('r1'))?.state).toBe('pending');
    expect(await blind.commit(a.commitment.seq, owner('r1'))).toMatchObject({ state: 'committed' });
    const b = await batch.appendPending(voucher(200n, 'r2'));
    if (!b.ok) throw new Error('append failed');
    expect(await blind.cancel(b.commitment.seq, owner('r2'))).toMatchObject({ state: 'cancelled' });
    expect(await prisma.event.count({ where: { kind: 'package_read' } })).toBe(0);
  });

  it('replay skips a damaged package (logged, journaled) and delivers the rest', async () => {
    const prisma = await openDatabase(
      migratedSqliteFile(new URL('../prisma/migrations/', import.meta.url), 'facilitator.db'),
    );
    cleanups.push(() => prisma.$disconnect());
    const logged: string[] = [];
    const logger = createLogger({
      destination: new Writable({
        write: (chunk, _e, cb) => (logged.push(String(chunk)), cb()),
      }),
    });
    const batch = new PrismaBatchStore(
      prisma,
      PackageCipher.fromKey(randomBytes(32)),
      undefined,
      logger,
    );
    const seqs: number[] = [];
    for (const [i, hash] of ['d1', 'd2', 'd3'].entries()) {
      const r = await batch.appendPending({
        ...voucher(100n, hash),
        channelKey: `obyte:testnet:aa:X${i}`,
      });
      if (!r.ok) throw new Error('append failed');
      seqs.push(r.commitment.seq);
    }
    await prisma.batchCommitment.update({
      where: { seq: seqs[1]! },
      data: { packageJson: 'garbage' },
    });
    const seller = 'S'.repeat(32);
    expect((await batch.pending(seller)).map((c) => c.seq)).toEqual([seqs[0], seqs[2]]);
    expect((await batch.journal(seller, 0)).map((c) => c.seq)).toEqual([seqs[0], seqs[2]]);
    const damaged = await prisma.event.findMany({ where: { kind: 'package_unreadable' } });
    expect(damaged.map((e) => JSON.parse(e.data ?? '{}'))).toMatchObject([
      { op: 'pending_replay', seq: seqs[1] },
      { op: 'journal', seq: seqs[1] },
    ]);
    expect(await prisma.event.count({ where: { kind: 'package_read' } })).toBe(4);
    expect(logged.filter((l) => l.includes('cannot be decrypted'))).toHaveLength(2);
    // a single read of the damaged package still fails closed
    await expect(batch.commitment(seqs[1]!)).rejects.toThrow(/not encrypted/);
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
    const a = PackageCipher.fromFile(path, { create: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const b = PackageCipher.fromFile(path, { create: false }); // same key on restart
    expect(b.decrypt(a.encrypt('x', 'h'), 'h')).toBe('x');
    chmodSync(path, 0o644);
    expect(() => PackageCipher.fromFile(path, { create: false })).toThrow(/chmod 600/);
  });

  it('startup never creates a key for a database with packages and refuses a wrong key', async () => {
    const prisma = await openDatabase(
      migratedSqliteFile(new URL('../prisma/migrations/', import.meta.url), 'facilitator.db'),
    );
    cleanups.push(() => prisma.$disconnect());
    const dir = mkdtempSync(join(tmpdir(), 'obbyx-key-'));
    const path = join(dir, 'package.key');
    const store = await PrismaBatchStore.open(prisma, path); // empty DB: creates the key
    const a = await store.appendPending(voucher(100n, 'd1'));
    if (!a.ok) throw new Error('append failed');
    await store.commit(a.commitment.seq, owner('d1'));
    const b = await store.appendPending(voucher(200n, 'd2'));
    if (!b.ok) throw new Error('append failed');
    await PrismaBatchStore.open(prisma, path); // restart with the same key

    // One damaged newest package does not look like a wrong key.
    await prisma.batchCommitment.update({
      where: { seq: b.commitment.seq },
      data: { packageJson: 'garbage' },
    });
    await PrismaBatchStore.open(prisma, path);

    // The key file went missing (e.g. a new mount): refuse instead of generating one.
    rmSync(path);
    await expect(PrismaBatchStore.open(prisma, path)).rejects.toThrow(
      /already holds encrypted channel packages/,
    );
    expect(existsSync(path)).toBe(false);

    // A different key at that path is refused.
    PackageCipher.fromFile(path, { create: true });
    await expect(PrismaBatchStore.open(prisma, path)).rejects.toThrow(/not the key/);
  });

  it('a key that cannot be created (read-only mount) fails with a clear message', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), 'obbyx-key-'));
    chmodSync(dir, 0o500);
    try {
      expect(() => PackageCipher.fromFile(join(dir, 'package.key'), { create: true })).toThrow(
        /Cannot create PACKAGE_KEY_FILE/,
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
