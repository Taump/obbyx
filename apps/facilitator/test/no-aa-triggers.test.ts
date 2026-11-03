import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0001: the facilitator never moves channel funds. Its code must not build
 * or send AA triggers (`close`, `confirm`, `fraud_proof`) or compose units for
 * channels; only the seller watcher does. This test enforces it in CI.
 *
 * Scanned: the facilitator app and the batch-settlement modules it runs. The
 * client helpers (batch/client.ts) and the exact broadcaster (which relays the
 * CLIENT-signed unit) are intentionally not part of the scan.
 */
const root = new URL('../../../', import.meta.url).pathname;
const SCANNED_DIRS = ['apps/facilitator/src'];
const SCANNED_FILES = [
  'packages/x402-obyte/src/batch/facilitator.ts',
  'packages/x402-obyte/src/batch/gateway.ts',
  'packages/x402-obyte/src/batch/store.ts',
  'packages/x402-obyte/src/batch/requirements.ts',
  'packages/x402-obyte/src/batch/watcher-protocol.ts',
];
const FORBIDDEN: [RegExp, string][] = [
  [/fraud_proof/, 'fraud_proof trigger'],
  [/\bclose\s*:\s*1\b/, 'close trigger payload'],
  [/\bconfirm\s*:\s*1\b/, 'confirm trigger payload'],
  [/\bcompose\s*\.\s*message\b/, 'unit composition'],
  [/\bpostJoint\b/, 'broadcasting a unit'],
  [/\b(openChannel|closeChannel|confirmClose|deposit)\s*\(/, 'channel client helper call'],
  [/@obbyx\/watcher|apps\/watcher/, 'watcher code import'],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the facilitator builds no AA triggers (ADR-0001)', () => {
  it('scans the facilitator code paths', () => {
    const scanned = [
      ...SCANNED_DIRS.flatMap((d) => files(join(root, d))),
      ...SCANNED_FILES.map((f) => join(root, f)),
    ];
    expect(scanned.length).toBeGreaterThan(5);
    const violations: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      for (const [re, what] of FORBIDDEN) {
        if (re.test(text)) violations.push(`${file.slice(root.length)}: ${what}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
