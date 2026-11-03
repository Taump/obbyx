import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  fingerprint,
  moduleLogger,
  parseModuleLevels,
  resolveModuleLevel,
  withLogContext,
} from '../src/logger/index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { lines, raw, destination };
}

const SECRET_SIG = 'MEUCIQDsecretSignatureValueThatMustNeverAppear==';
const SECRET_KEY = 'sk_live_must_not_leak_0123456789';

describe('logger redaction', () => {
  it('never writes sensitive values, at any supported depth, but keeps a fingerprint', () => {
    const { lines, raw, destination } = capture();
    const log = createLogger({ destination, level: 'trace' });

    log.info({ authentifiers: { r: SECRET_SIG } }, 'top level');
    log.info({ payment: { signedPackage: { sig: SECRET_SIG } } }, 'nested 1');
    log.info({ a: { b: { joint: { unit: { authors: [SECRET_SIG] } } } } }, 'nested 2');
    log.info({ x: { y: { z: { apiKey: SECRET_KEY } } } }, 'nested 3');
    log.info({ headers: { 'payment-signature': SECRET_SIG, 'x-api-key': SECRET_KEY } }, 'headers');
    log.info({ req: { headers: { authorization: `Bearer ${SECRET_KEY}` } } }, 'req headers');

    const all = raw.join('\n');
    expect(all).not.toContain(SECRET_SIG);
    expect(all).not.toContain(SECRET_KEY);
    expect(lines[0]?.['authentifiers']).toMatch(/^\[redacted sha256:[0-9a-f]{12}\]$/);
  });

  it('fingerprints are stable and independent of key order', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint('x')).not.toBe(fingerprint('y'));
    expect(fingerprint({ n: 10n })).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});

describe('logger correlation', () => {
  it('adds context fields to every line inside withLogContext, including nested async work', async () => {
    const { lines, destination } = capture();
    const log = moduleLogger(createLogger({ destination }), 'x402.exact');

    await withLogContext({ requestId: 'req-1', binding: 'b-1' }, async () => {
      log.info('outer');
      await new Promise((r) => setTimeout(r, 1));
      await withLogContext({ proofId: 'p-1' }, async () => {
        log.info('inner');
      });
    });
    log.info('outside');

    expect(lines[0]).toMatchObject({ requestId: 'req-1', binding: 'b-1', module: 'x402.exact' });
    expect(lines[1]).toMatchObject({ requestId: 'req-1', binding: 'b-1', proofId: 'p-1' });
    expect(lines[2]?.['requestId']).toBeUndefined();
  });
});

describe('module levels', () => {
  it('applies the most specific configured level', () => {
    const levels = parseModuleLevels('x402=warn, x402.exact=debug ,hub=trace');
    expect(resolveModuleLevel('x402.exact.verify', levels)).toBe('debug');
    expect(resolveModuleLevel('x402.batch', levels)).toBe('warn');
    expect(resolveModuleLevel('watcher', levels)).toBeUndefined();
  });

  it('module children log below the root level when configured', () => {
    const { lines, destination } = capture();
    const root = createLogger({ destination, level: 'info', moduleLevels: { hub: 'debug' } });
    moduleLogger(root, 'hub.ws').debug('visible');
    moduleLogger(root, 'facilitator').debug('hidden');
    expect(lines.map((l) => l['msg'])).toEqual(['visible']);
  });

  it('rejects malformed LOG_LEVELS', () => {
    expect(() => parseModuleLevels('hub=loud')).toThrow(/Invalid LOG_LEVELS/);
    expect(() => parseModuleLevels('hub')).toThrow(/Invalid LOG_LEVELS/);
  });
});
