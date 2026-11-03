import { describe, expect, it } from 'vitest';
import { KeyedQueue } from '../src/util/keyed-queue.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('KeyedQueue', () => {
  it('runs tasks of one key one at a time, in order; other keys in parallel', async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      q.run('a', task('a1')),
      q.run('a', task('a2')),
      q.run('b', task('b1')),
    ]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'));
    expect(log.indexOf('start b1')).toBeLessThan(log.indexOf('end a1'));
  });

  it('a failing task does not block the next one and the queue cleans up', async () => {
    const q = new KeyedQueue();
    const failed = q.run('a', async () => {
      throw new Error('boom');
    });
    const next = q.run('a', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
    await tick();
    expect(q.size).toBe(0);
  });
});
