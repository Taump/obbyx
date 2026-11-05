import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pino, type DestinationStream, type Level, type Logger, type LoggerOptions } from 'pino';

/**
 * Unified logger for all obbyx packages and apps (plan §7).
 *
 * - Structured JSON (pino), human-readable output in dev via pino-pretty.
 * - Correlation fields (requestId, traceId, binding, proofId, ...) are taken
 *   from an AsyncLocalStorage context, so every log line written while a
 *   payment is processed carries them automatically — in the seller middleware,
 *   the facilitator and the watcher alike.
 * - Sensitive values (signatures, payment packages, signed units, API keys,
 *   challenges, private keys) are never written; they are replaced by a short
 *   SHA-256 fingerprint so they can still be correlated across logs.
 * - Libraries never call `console`; they receive a Logger via DI and create
 *   per-module children with {@link moduleLogger}.
 */
export type { Logger, Level } from 'pino';

export const LOG_LEVELS: readonly Level[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

/** Correlation fields propagated through a payment flow. */
export interface LogContext {
  requestId?: string;
  traceId?: string;
  binding?: string;
  proofId?: string;
  network?: string;
  scheme?: string;
  x402Version?: number;
  sellerId?: string;
  aa?: string;
  seq?: string;
}

const contextStorage = new AsyncLocalStorage<Readonly<LogContext>>();

/**
 * Runs `fn` with additional correlation fields. Nested calls merge with (and
 * may override) the outer context.
 */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  const parent = contextStorage.getStore();
  return contextStorage.run(Object.freeze({ ...parent, ...stripUndefined(fields) }), fn);
}

export function getLogContext(): Readonly<LogContext> {
  return contextStorage.getStore() ?? {};
}

function stripUndefined(fields: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as LogContext;
}

/**
 * Short, stable fingerprint of a sensitive value: `sha256:<12 hex>`.
 * Use it to log *that* a value was seen without revealing it.
 */
export function fingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

/**
 * Field names whose values are bearer-sensitive or secret. They are redacted at
 * the top level and up to three levels deep. Naming convention: code that logs
 * such data must use one of these field names (enforced by tests and review).
 */
export const SENSITIVE_FIELDS: readonly string[] = [
  'authentifiers',
  'signedPackage',
  'signed_package',
  'sentByPeer',
  'paymentPayload',
  'paymentSignature',
  'xPayment',
  'joint',
  'signedUnit',
  'apiKey',
  'authorization',
  'cookie',
  'challengeSignature',
  'privateKey',
  'wif',
  'packageJson',
  'mnemonic',
  'seed',
  'password',
  'secret',
];

const SENSITIVE_HEADERS: readonly string[] = [
  'payment-signature',
  'x-payment',
  'authorization',
  'cookie',
  'x-api-key',
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const field of SENSITIVE_FIELDS) {
    paths.push(field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`);
  }
  for (const header of SENSITIVE_HEADERS) {
    paths.push(`headers["${header}"]`, `*.headers["${header}"]`);
  }
  return paths;
}

export interface CreateLoggerOptions {
  /** Base level. Default: `info`. */
  level?: Level;
  /** Per-module overrides, e.g. `{ 'x402.exact': 'debug', hub: 'trace' }`. */
  moduleLevels?: Readonly<Record<string, Level>>;
  /** Service name written into every line (`service` field). */
  service?: string;
  /**
   * Pretty-print for local development. Needs the optional `pino-pretty`
   * package; without it the logger falls back to JSON and says so once.
   */
  pretty?: boolean;
  /** Custom destination (tests, files). Ignored when `pretty` is set. */
  destination?: DestinationStream;
}

const moduleLevelsByLogger = new WeakMap<Logger, Readonly<Record<string, Level>>>();

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: options.service === undefined ? {} : { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: redactPaths(), censor: (value) => redacted(value) },
    serializers: { err: pino.stdSerializers.err },
    mixin: () => ({ ...getLogContext() }),
  };

  const pretty = options.pretty === true && prettyAvailable();
  const logger = pretty
    ? pino({ ...pinoOptions, transport: { target: 'pino-pretty', options: { colorize: true } } })
    : options.destination === undefined
      ? pino(pinoOptions)
      : pino(pinoOptions, options.destination);
  if (options.pretty === true && !pretty) {
    logger.warn('pretty logs need the pino-pretty package (npm i pino-pretty); writing JSON');
  }

  moduleLevelsByLogger.set(logger, options.moduleLevels ?? {});
  return logger;
}

/** Whether pino can load the `pino-pretty` transport (an optional package). */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function redacted(value: unknown): string {
  return value === undefined || value === null ? '[redacted]' : `[redacted ${fingerprint(value)}]`;
}

/**
 * Child logger for a module (`x402.exact`, `hub`, `watcher.sync`, ...).
 * Applies the most specific per-module level: `x402.exact.verify` inherits a
 * level configured for `x402.exact` or `x402`.
 */
export function moduleLogger(
  root: Logger,
  module: string,
  bindings: Record<string, unknown> = {},
): Logger {
  const levels = findModuleLevels(root);
  const level = resolveModuleLevel(module, levels);
  const child = root.child({ module, ...bindings }, level === undefined ? {} : { level });
  moduleLevelsByLogger.set(child, levels);
  return child;
}

function findModuleLevels(logger: Logger): Readonly<Record<string, Level>> {
  return moduleLevelsByLogger.get(logger) ?? {};
}

export function resolveModuleLevel(
  module: string,
  levels: Readonly<Record<string, Level>>,
): Level | undefined {
  const parts = module.split('.');
  for (let i = parts.length; i > 0; i--) {
    const level = levels[parts.slice(0, i).join('.')];
    if (level !== undefined) return level;
  }
  return undefined;
}

/**
 * Parses `LOG_LEVELS="x402.exact=debug,hub=trace"`. Invalid entries throw so
 * misconfiguration is visible at startup instead of silently ignored.
 */
export function parseModuleLevels(spec: string | undefined): Record<string, Level> {
  const result: Record<string, Level> = {};
  if (spec === undefined || spec.trim() === '') return result;
  for (const entry of spec.split(',')) {
    const [module, level] = entry.split('=').map((s) => s.trim());
    if (!module || !level || !isLevel(level)) {
      throw new Error(`Invalid LOG_LEVELS entry "${entry}" (expected module=level)`);
    }
    result[module] = level;
  }
  return result;
}

export function isLevel(value: string): value is Level {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Builds a logger from standard env vars: LOG_LEVEL, LOG_LEVELS, LOG_PRETTY. */
export function createLoggerFromEnv(
  service: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Logger {
  const level = env['LOG_LEVEL'] ?? 'info';
  if (!isLevel(level)) throw new Error(`Invalid LOG_LEVEL "${level}"`);
  return createLogger({
    service,
    level,
    moduleLevels: parseModuleLevels(env['LOG_LEVELS']),
    pretty: env['LOG_PRETTY'] === '1' || env['LOG_PRETTY'] === 'true',
  });
}
