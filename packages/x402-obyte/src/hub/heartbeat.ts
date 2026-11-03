import type obyte from 'obyte';

/**
 * Keeps an obyte.js hub connection alive. obyte.js does not schedule
 * heartbeats itself: the application must call `client.api.heartbeat()`
 * periodically (its WSClient then skips the call if traffic was recent,
 * and closes a connection whose heartbeat goes unanswered, letting
 * `reconnect: true` re-establish it). Hubs drop idle peers without this.
 *
 * Returns a function that stops the timer.
 */
export function startHeartbeat(client: obyte.Client, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    client.api.heartbeat().catch(() => undefined); // closed/reconnecting: the next tick retries
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
