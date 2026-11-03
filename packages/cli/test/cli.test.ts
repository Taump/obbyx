import { encodePaymentResponseHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';
import { commandPaths, renderHelp, runCli } from '../src/cli.js';

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l = '') => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('obbyx CLI (yargs)', () => {
  it('--help lists every command and the environment', async () => {
    const r = await run('--help');
    expect(r.code).toBe(0);
    for (const c of [
      'init',
      'address',
      'balance',
      'faucet',
      'pay <url>',
      'doctor',
      'logs',
      'decode',
      'channel',
    ]) {
      expect(r.out).toContain(`obbyx ${c}`);
    }
    expect(r.out).toContain('OBBYX_HOME');
  });

  it('no command, unknown command and missing arguments are usage errors (exit 1)', async () => {
    expect(await run()).toMatchObject({
      code: 1,
      err: expect.stringContaining('Choose a command'),
    });
    expect(await run('bogus')).toMatchObject({
      code: 1,
      err: expect.stringContaining('Unknown command'),
    });
    expect(await run('pay')).toMatchObject({ code: 1 });
    expect(await run('pay', 'http://x')).toMatchObject({
      code: 1,
      err: expect.stringContaining('--max'),
    });
    expect(await run('channel')).toMatchObject({
      code: 1,
      err: expect.stringContaining('channel command'),
    });
    expect(await run('address', '--network', 'mainnet')).toMatchObject({
      code: 1,
      err: expect.stringContaining('Choices'),
    });
    expect(await run('init', '--no-such-flag')).toMatchObject({
      code: 1,
      err: expect.stringContaining('Unknown argument'),
    });
  });

  it('validates pay arguments before touching the wallet', async () => {
    const r = await run('pay', 'http://x', '--max', '0.1', '--wait', 'abc');
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('--wait') });
  });

  it('decode recognizes an x402 header', async () => {
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: 'T',
      network: 'obyte:testnet',
    });
    const r = await run('decode', header);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      header: 'PAYMENT-RESPONSE',
      value: { success: true },
    });
    expect(await run('decode', 'Zm9v')).toMatchObject({ code: 1 });
  });

  it('every command path renders help (source of the CLI reference)', async () => {
    const paths = commandPaths();
    expect(paths).toContainEqual(['channel', 'open']);
    for (const p of paths) {
      const help = await renderHelp(p);
      expect(help, p.join(' ')).toContain(p.length ? `obbyx ${p.join(' ')}` : 'Usage: obbyx');
    }
  });
});
