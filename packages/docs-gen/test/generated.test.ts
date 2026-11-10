import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_REASONS } from '@obbyx/obyte';
import { BATCH_REASONS, EXACT_SETTLE_REASONS } from '@obbyx/x402-obyte';
import { describe, expect, it } from 'vitest';
import { ERROR_GROUPS } from '../src/errors.js';
import { generate } from '../src/generate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated' || name === 'node_modules') return [];
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('generated reference pages', () => {
  it('are up to date with the code (run `pnpm docs:gen`)', async () => {
    for (const [file, content] of Object.entries(await generate())) {
      expect(readFileSync(join(root, file), 'utf8'), file).toBe(content);
    }
  });

  it('every error code in the sources is documented exactly once', () => {
    const documented = ERROR_GROUPS.flatMap((g) => g.errors.map((e) => e.code));
    expect(new Set(documented).size).toBe(documented.length);
    const codes = new Set<string>([
      ...Object.values(EXACT_REASONS),
      ...Object.values(EXACT_SETTLE_REASONS),
      ...Object.values(BATCH_REASONS),
    ]);
    const dirs = [
      'packages/obyte/src',
      'packages/x402-obyte/src',
      'packages/sdk/src',
      'packages/cli/src',
      'apps/facilitator/src',
      'apps/watcher/src',
    ];
    for (const file of dirs.flatMap((d) => sources(join(root, d)))) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /'((?:invalid|payment|settlement|unexpected|package)_[a-z0-9_]+)'/g,
      )) {
        if (m[1]) codes.add(m[1]);
      }
    }
    // Event kinds of the payment journal, not error codes.
    for (const kind of ['package_read', 'package_unreadable']) codes.delete(kind);
    const missing = [...codes].filter((c) => !documented.includes(c));
    expect(missing).toEqual([]);
  });
});
