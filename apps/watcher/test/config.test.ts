import { describe, expect, it } from 'vitest';
import { watcherEnvSchema } from '../src/config.js';

const url = (FACILITATOR_URL: string) => watcherEnvSchema.safeParse({ FACILITATOR_URL }).success;

describe('watcher FACILITATOR_URL', () => {
  it('allows plain http only on this machine (vouchers are bearer-sensitive)', () => {
    expect(url('http://127.0.0.1:4021')).toBe(true);
    expect(url('http://localhost:4021')).toBe(true);
    expect(url('http://[::1]:4021')).toBe(true);
    expect(url('https://facilitator.example')).toBe(true);
    expect(url('http://facilitator.example')).toBe(false);
    expect(url('http://127.0.0.1.evil.example')).toBe(false);
    expect(url('ftp://127.0.0.1')).toBe(false);
  });
});

describe('watcher FACILITATOR_ALLOW_HTTP', () => {
  it('allows http:// to another host only when explicitly enabled (docker compose network)', () => {
    const parse = (env: Record<string, string>) => watcherEnvSchema.safeParse(env).success;
    expect(parse({ FACILITATOR_URL: 'http://facilitator:4021' })).toBe(false);
    expect(parse({ FACILITATOR_URL: 'http://facilitator:4021', FACILITATOR_ALLOW_HTTP: '1' })).toBe(
      true,
    );
  });
});
