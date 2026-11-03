import { decodeAny } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function decodeCommand({ out, done }: CommandContext): Cmd<{ value: string }> {
  return {
    command: 'decode <value>',
    describe: 'Decode an x402 header (PAYMENT-REQUIRED / -SIGNATURE / -RESPONSE)',
    builder: (y) =>
      y.positional('value', {
        type: 'string',
        demandOption: true,
        describe: 'Base64 header value',
      }),
    handler: (a) => {
      out(JSON.stringify(decodeAny(a.value), null, 2));
      done(0);
    },
  };
}
