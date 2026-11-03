/**
 * Outcome of a check. Rejections carry a stable `reason` code (x402 style) and a
 * human-readable message; they are expected outcomes, not exceptions.
 */
export type Verdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export function accept<T>(value: T): Verdict<T> {
  return { ok: true, value };
}

export function reject<T = never>(reason: string, message: string): Verdict<T> {
  return { ok: false, reason, message };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}
