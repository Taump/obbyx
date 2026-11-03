import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { ObbyxError } from '@obbyx/obyte';
import { StoreLockedError } from '@obbyx/x402-obyte';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Opens the facilitator database with Prisma (SQLite via better-sqlite3) and
 * takes the exclusive lock (ADR-0005): `locking_mode = EXCLUSIVE` plus a write,
 * so a second facilitator process on the same file fails fast.
 *
 * The adapter uses ONE connection and serializes transactions with a mutex,
 * but plain queries are not serialized against an open transaction. Stores
 * therefore run every operation inside `$transaction`.
 *
 * Schema: Prisma migrations in prisma/migrations, applied with
 * `pnpm --filter @obbyx/facilitator db:migrate` (also done by `start`).
 */
export class SchemaNotMigratedError extends ObbyxError {
  constructor(path: string, cause: unknown) {
    super(
      'schema_not_migrated',
      `Database ${path} has no obbyx schema. Run: pnpm --filter @obbyx/facilitator db:migrate`,
      { cause, details: { path } },
    );
  }
}

export async function openDatabase(path: string): Promise<PrismaClient> {
  const adapter = new PrismaBetterSqlite3({ url: `file:${path}`, timeout: 1_000 });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe('PRAGMA synchronous = FULL');
    await prisma.$queryRawUnsafe('PRAGMA locking_mode = EXCLUSIVE');
    const now = Math.floor(Date.now() / 1000);
    // First write acquires the exclusive lock for the life of the connection.
    await prisma.instance.upsert({
      where: { id: 1 },
      create: { id: 1, pid: process.pid, startedAt: now },
      update: { pid: process.pid, startedAt: now },
    });
  } catch (err) {
    await prisma.$disconnect().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    if (/database is locked|SQLITE_BUSY/i.test(message)) throw new StoreLockedError(path, err);
    // P2021: "The table ... does not exist" (Prisma); "no such table" (SQLite).
    const code = (err as { code?: unknown }).code;
    if (code === 'P2021' || /no such table|does not exist/i.test(message)) {
      throw new SchemaNotMigratedError(path, err);
    }
    throw err;
  }
  return prisma;
}
