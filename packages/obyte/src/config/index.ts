import { z } from 'zod';
import { ObbyxError } from '../core/errors.js';

/**
 * Configuration is validated with zod at startup; an invalid config stops the
 * process with a list of *all* problems rather than failing later at runtime.
 * The same schemas generate the configuration reference in the docs.
 */
export class ConfigError extends ObbyxError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('invalid_config', `Invalid configuration:\n  - ${issues.join('\n  - ')}`, {
      details: { issues },
    });
    this.issues = issues;
  }
}

export function loadConfig<S extends z.ZodType>(schema: S, source: unknown): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}

/** Reusable env-var helpers. */
export const envBoolean = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no'])
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

/**
 * An on/off env var kept as its string value (so the generated docs show the
 * allowed values and the default); read it with {@link flagOn}.
 */
export const envFlag = z.enum(['1', '0', 'true', 'false']);
export const flagOn = (value: z.infer<typeof envFlag>): boolean =>
  value === '1' || value === 'true';

export const envPort = z.coerce.number().int().min(1).max(65535);

/** Largest Node timer delay; above it a timer fires after 1 ms (a hot loop). */
export const MAX_TIMER_MS = 2_147_483_647;

/** An Obyte hub URL: obyte.js connects with the `ws` library, which accepts ws(s) and http(s). */
export const hubUrlSchema = z.url({ protocol: /^(wss?|https?)$/ });

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
