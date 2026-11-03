/**
 * Runs tasks one at a time per key, in arrival order; different keys run in
 * parallel. A failing task never blocks the ones queued after it. Used where
 * check-then-act must not interleave within one process: per channel in the
 * batch facilitator and in the seller watcher.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with queued or running tasks (for tests and diagnostics). */
  get size(): number {
    return this.tails.size;
  }
}
