import { defineConfig } from 'prisma/config';

// Used by the Prisma CLI (generate, migrate). The running facilitator gets its
// database path from DB_PATH (see src/config.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${process.env['DB_PATH'] ?? './data/watcher.db'}` },
});
