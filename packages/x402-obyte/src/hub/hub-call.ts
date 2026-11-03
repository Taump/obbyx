/**
 * Outcome of one obyte.js hub request (ADR-0006, invariant I7).
 *
 * obyte.js requests have no timeout. It rejects with the hub's error value
 * (usually a string) for definite hub errors, and with an `Error` for transport
 * failures. A timeout or transport failure is an UNKNOWN outcome — for
 * `postJoint` the unit may have been accepted.
 */
export type HubOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'hub_error'; readonly error: string }
  | { readonly kind: 'unknown'; readonly error: string };

export async function hubCall<T>(
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<HubOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      request(),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error(`hub request timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { kind: 'ok', value };
  } catch (err) {
    if (err instanceof Error || err === null || err === undefined) {
      return { kind: 'unknown', error: err instanceof Error ? err.message : 'no error value' };
    }
    return { kind: 'hub_error', error: typeof err === 'string' ? err : safeJson(err) };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
