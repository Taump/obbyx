import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { OBYTE_NETWORKS, type ObyteNetwork, getNetwork, isAddress, isAssetId } from '@obbyx/obyte';
import {
  ConfigError,
  MAX_TIMER_MS,
  envFlag,
  envPort,
  flagOn,
  hubUrlSchema,
  loadConfig,
  logLevelSchema,
} from '@obbyx/obyte/config';
import { z } from 'zod';

/**
 * Facilitator configuration from environment variables (validated at startup;
 * every problem is reported at once). Documented in docs/guide/facilitator.md.
 */
const list = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0),
);

export const facilitatorEnvSchema = z.object({
  HOST: z
    .string()
    .default('127.0.0.1')
    .describe(
      'Interface to listen on. Keep 127.0.0.1 unless the facilitator sits behind a TLS proxy.',
    ),
  PORT: envPort.default(4021).describe('HTTP port.'),
  DB_PATH: z
    .string()
    .default('./data/facilitator.db')
    .describe('SQLite database file (Prisma). One facilitator process per file (exclusive lock).'),
  PACKAGE_KEY_FILE: z
    .string()
    .default('./data/package.key')
    .describe(
      'File with the 32-byte key (base64) that encrypts stored channel packages. Created (mode 0600) only while the database holds no package; with stored packages a missing or different key stops startup. Keep it outside the database directory and its backups.',
    ),
  NETWORKS: list
    .default(['obyte:testnet'])
    .describe('Comma-separated CAIP-2 networks to serve: obyte:testnet, obyte:livenet.'),
  HUB_URL_LIVENET: hubUrlSchema
    .optional()
    .describe('Obyte hub WebSocket URL for livenet (default: the public hub).'),
  HUB_URL_TESTNET: hubUrlSchema
    .optional()
    .describe('Obyte hub WebSocket URL for testnet (default: the public testnet hub).'),
  ASSETS_LIVENET: list
    .default(['base'])
    .describe('Comma-separated assets accepted on livenet: base (GBYTE) and/or asset ids.'),
  ASSETS_TESTNET: list.default(['base']).describe('Comma-separated assets accepted on testnet.'),
  FINALITY: z
    .enum(['stable', 'accepted'])
    .default('stable')
    .describe(
      'When /settle reports success: stable (unit is on the stable main chain, proven) or accepted (broadcast and accepted by the hub; faster, reversible on a double-spend).',
    ),
  HUB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(15_000)
    .describe('Timeout of one hub request. A timeout is an unknown outcome, never a failure.'),
  PUBLISH_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(3600)
    .default(300)
    .describe('How long a verified unit may wait for settlement before it is refused.'),
  MAX_CLOCK_SKEW_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(120)
    .describe('Allowed difference between unit timestamps and the facilitator clock.'),
  MAX_LAST_BALL_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(10_800)
    .describe(
      'Oldest last ball an exact payment unit may reference. With few transactions the network stabilizes slowly (up to ~2 h is normal); freshness of the payment itself is guaranteed by the offer binding.',
    ),
  RECOVERY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(MAX_TIMER_MS)
    .default(5_000)
    .describe('How often pending settlements are re-checked in the background.'),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(4096)
    .max(1_048_576)
    .default(65_536)
    .describe('Maximum request body size.'),
  FACILITATOR_ADDRESSES: list
    .refine((addresses) => addresses.every(isAddress), 'every entry must be an Obyte address')
    .default([])
    .describe(
      'Comma-separated Obyte addresses the facilitator operator controls; a payment whose payer is one of them is refused.',
    ),
  FACILITATOR_API_KEYS: list
    .default([])
    .describe(
      'Comma-separated shared keys for /verify and /settle (Authorization: Bearer). Empty = open: bind to localhost only.',
    ),
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(0)
    .default(600)
    .describe('Requests per minute per client to /verify and /settle (0 = unlimited).'),
  BATCH_ENABLED: envFlag
    .default('1')
    .describe(
      'Serve the batch-settlement scheme (payment channels), on the networks where the channel base AA v1.2 is deployed (testnet only for now).',
    ),
  MIN_CHANNEL_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    // Floor 1 h: the watcher reacts to a close only once it is stable (~1-2 h lag).
    .min(3600)
    .default(14_400)
    .describe(
      'Smallest channel dispute window the facilitator accepts. The seller watcher reacts to a close only once it is stable, and stabilization alone can lag ~2 h: keep this above that lag plus any watcher outage.',
    ),
  WATCHER_ACK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000)
    .describe(
      'How long /settle waits for the seller watcher to store a voucher; after that the payment is reported as settlement_pending.',
    ),
  WATCHER_HEARTBEAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMER_MS)
    .default(45_000)
    .describe('A watcher that has not sent a heartbeat for this long is considered offline.'),
  WATCHER_MIN_BYTES: z.coerce
    .bigint()
    .min(0n)
    .default(100_000n)
    .describe(
      'Minimum bytes a seller watcher must hold for defense transactions before channel payments are accepted.',
    ),
  LOG_LEVEL: logLevelSchema
    .default('info')
    .describe('Default log level: trace, debug, info, warn, error, fatal, silent.'),
  LOG_LEVELS: z.string().optional().describe('Per-module levels, e.g. "exact=debug,hub=warn".'),
  LOG_PRETTY: z
    .string()
    .optional()
    .describe('1 = human-readable logs (development); default is JSON lines.'),
});

export interface NetworkConfig {
  readonly network: ObyteNetwork;
  readonly hubUrl: string;
  readonly assets: ReadonlySet<string>;
}

export interface FacilitatorConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly packageKeyFile: string;
  readonly networks: readonly NetworkConfig[];
  readonly finality: 'stable' | 'accepted';
  readonly hubTimeoutMs: number;
  readonly publishWindowSeconds: number;
  readonly maxLastBallAgeSeconds: number;
  readonly maxClockSkewSeconds: number;
  readonly recoveryIntervalMs: number;
  readonly bodyLimitBytes: number;
  readonly facilitatorAddresses: readonly string[];
  readonly apiKeys: readonly string[];
  readonly ratePerMinute: number;
  readonly batch: {
    readonly enabled: boolean;
    readonly minChannelTimeoutSeconds: number;
    readonly ackTimeoutMs: number;
    readonly heartbeatTimeoutMs: number;
    readonly minWatcherBytes: bigint;
  };
}

export function loadFacilitatorConfig(
  env: Record<string, string | undefined> = process.env,
): FacilitatorConfig {
  const schema = facilitatorEnvSchema.superRefine((e, ctx) => {
    // Aliases (obyte:testnet / obyte-testnet) count as the same network.
    const served = new Set<string>();
    for (const id of e.NETWORKS) {
      let caip2: string;
      try {
        caip2 = getNetwork(id).caip2;
      } catch {
        ctx.addIssue({ code: 'custom', path: ['NETWORKS'], message: `Unknown network ${id}` });
        continue;
      }
      if (served.has(caip2)) {
        ctx.addIssue({ code: 'custom', path: ['NETWORKS'], message: `${id} is listed twice` });
      }
      served.add(caip2);
    }
    for (const key of ['ASSETS_LIVENET', 'ASSETS_TESTNET'] as const) {
      for (const asset of e[key]) {
        if (!isAssetId(asset))
          ctx.addIssue({ code: 'custom', path: [key], message: `Invalid asset ${asset}` });
      }
    }
  });
  const e = loadConfig(schema, env);
  // The default key path (./data) is kept for existing deployments, but in
  // production the path must be chosen: next to the DB, a copy holds both.
  if (env['NODE_ENV'] === 'production' && (env['PACKAGE_KEY_FILE'] ?? '').trim() === '') {
    throw new ConfigError([
      'PACKAGE_KEY_FILE: must be set when NODE_ENV=production, outside the database directory (an existing deployment may set ./data/package.key and move the file later)',
    ]);
  }
  return {
    host: e.HOST,
    port: e.PORT,
    dbPath: e.DB_PATH,
    packageKeyFile: e.PACKAGE_KEY_FILE,
    networks: e.NETWORKS.map((id) => {
      const network = getNetwork(id);
      const testnet = network === OBYTE_NETWORKS.testnet;
      return {
        network,
        hubUrl: (testnet ? e.HUB_URL_TESTNET : e.HUB_URL_LIVENET) ?? network.defaultHubUrl,
        assets: new Set(testnet ? e.ASSETS_TESTNET : e.ASSETS_LIVENET),
      };
    }),
    finality: e.FINALITY,
    hubTimeoutMs: e.HUB_TIMEOUT_MS,
    publishWindowSeconds: e.PUBLISH_WINDOW_SECONDS,
    maxLastBallAgeSeconds: e.MAX_LAST_BALL_AGE_SECONDS,
    maxClockSkewSeconds: e.MAX_CLOCK_SKEW_SECONDS,
    recoveryIntervalMs: e.RECOVERY_INTERVAL_MS,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    facilitatorAddresses: e.FACILITATOR_ADDRESSES,
    apiKeys: e.FACILITATOR_API_KEYS,
    ratePerMinute: e.RATE_LIMIT_PER_MINUTE,
    batch: {
      enabled: flagOn(e.BATCH_ENABLED),
      minChannelTimeoutSeconds: e.MIN_CHANNEL_TIMEOUT_SECONDS,
      ackTimeoutMs: e.WATCHER_ACK_TIMEOUT_MS,
      heartbeatTimeoutMs: e.WATCHER_HEARTBEAT_TIMEOUT_MS,
      minWatcherBytes: e.WATCHER_MIN_BYTES,
    },
  };
}

/** The package key file lies inside the database's directory (a copy would hold both). */
export function packageKeyNextToDb(
  config: Pick<FacilitatorConfig, 'dbPath' | 'packageKeyFile'>,
): boolean {
  if (config.dbPath === ':memory:') return false;
  const rel = relative(resolve(dirname(config.dbPath)), resolve(config.packageKeyFile));
  return !rel.startsWith('..') && !isAbsolute(rel);
}
