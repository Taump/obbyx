/**
 * Base error for all obbyx packages.
 *
 * `code` is a stable machine-readable identifier. Payment-related errors use
 * x402 reason codes (e.g. `invalid_exact_obyte_payload_signature`) so they can
 * be mapped 1:1 to `invalidReason` / `errorReason` in facilitator responses.
 */
export class ObbyxError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }
}
