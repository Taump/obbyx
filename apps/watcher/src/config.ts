import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Seller watcher configuration (environment variables). Documented in docs/reference/configuration.md. */
export const watcherEnvSchema = z.object({
  NETWORK: z
    .string()
    .default('obyte:testnet')
    .describe('Network of the seller channels: testnet, livenet or a CAIP-2 id.'),
  FACILITATOR_URL: z
    .url()
    .default('http://127.0.0.1:4021')
    .describe('Facilitator base URL; the watcher connects to its /watcher WebSocket.'),
  HUB_URL: z
    .url()
    .optional()
    .describe('Obyte hub WebSocket URL (default: the public hub of NETWORK).'),
  DB_PATH: z
    .string()
    .default('./data/watcher.db')
    .describe(
      'SQLite database with the stored vouchers (Prisma). Losing it can lose earned funds.',
    ),
  OBBYX_HOME: z
    .string()
    .default(join(homedir(), '.obbyx'))
    .describe('Directory with the seller wallet (wallet-<network>.json, created by `obbyx init`).'),
  CLOSE_AT_AMOUNT: z.coerce
    .bigint()
    .min(1n)
    .default(1_000_000n)
    .describe('Close (cash out) a channel once the unclaimed amount reaches this many bytes.'),
  CLOSE_AFTER_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(86_400)
    .describe('Close a channel that has unclaimed payments older than this.'),
  POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15_000)
    .describe('How often channels are re-checked on the ledger (in addition to push events).'),
  HUB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(15_000)
    .describe('Timeout of one hub request.'),
});

export type WatcherEnv = z.infer<typeof watcherEnvSchema>;
