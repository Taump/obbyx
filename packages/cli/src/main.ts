#!/usr/bin/env node
import { hideBin } from 'yargs/helpers';
import { runCli } from './cli.js';

runCli(hideBin(process.argv), {
  out: (line = '') => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
