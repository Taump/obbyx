import { loadWallet } from '@obbyx/obyte/wallet';
import { resolveNetwork } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function addressCommand({ out, done }: CommandContext): Cmd {
  return {
    command: 'address',
    describe: 'Show your address',
    handler: (a) => {
      out(loadWallet(resolveNetwork(a.network)).address);
      done(0);
    },
  };
}
