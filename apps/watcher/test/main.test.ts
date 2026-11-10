import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBYTE_NETWORKS } from '@obbyx/obyte';
import { createWallet } from '@obbyx/obyte/wallet';
import { expect, it } from 'vitest';

it('exits with code 1 when startup fails (database without the watcher schema)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obbyx-watcher-main-'));
  const env = { ...process.env, OBBYX_HOME: dir, LOG_LEVEL: 'fatal' };
  createWallet(OBYTE_NETWORKS.testnet, { env });
  const db = join(dir, 'watcher.db');
  writeFileSync(db, ''); // an empty SQLite file: not migrated
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  let out = '';
  const code = await new Promise<number | null>((resolve) => {
    const child = execFile(
      process.execPath,
      ['--conditions=@obbyx/source', '--import', 'tsx', main],
      {
        env: { ...env, NETWORK: 'testnet', DB_PATH: db, HUB_URL: 'ws://127.0.0.1:9' },
        timeout: 20_000,
      },
    );
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', resolve);
  });
  expect(code).toBe(1);
  expect(out).toContain('watcher failed to start');
}, 30_000);
