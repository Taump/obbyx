import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.js';

/** `pnpm docs:gen` writes the reference pages; `--check` fails if any is out of date. */
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const stale: string[] = [];
for (const [file, content] of Object.entries(await generate())) {
  const path = join(root, file);
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === content) continue;
  if (check) stale.push(file);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    process.stdout.write(`wrote ${file}\n`);
  }
}
if (stale.length) {
  process.stderr.write(`Out of date (run pnpm docs:gen): ${stale.join(', ')}\n`);
  process.exit(1);
}
