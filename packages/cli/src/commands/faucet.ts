import { loadWallet } from '@obbyx/obyte/wallet';
import { requestFromFaucet } from '../faucet/faucet.js';
import { cliLogger, resolveNetwork, seconds } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function faucetCommand({ out, done }: CommandContext): Cmd<{ timeout: string }> {
  return {
    command: 'faucet',
    describe: 'Get free testnet bytes (once per 24 h)',
    builder: (y) =>
      y.option('timeout', {
        type: 'string',
        default: '60',
        describe: 'How long to wait for the faucet bot, seconds',
      }),
    handler: async (a) => {
      const network = resolveNetwork(a.network);
      const wallet = loadWallet(network);
      out(`Asking the ${network.caip2} faucet to fund ${wallet.address} ...`);
      const result = await requestFromFaucet({
        network,
        address: wallet.address,
        logger: cliLogger(),
        timeoutMs: seconds(a.timeout, 'timeout') * 1000,
        onBotText: (text) => out(`  faucet: ${text}`),
      });
      switch (result.status) {
        case 'sent':
          out(
            'Bytes are on the way. They become spendable once stable (minutes, up to ~2 h on a quiet network): obbyx balance',
          );
          return done(0);
        case 'rate_limited':
          out('The faucet pays each device once per 24 hours. Try again later.');
          return done(2);
        case 'rejected':
          out('The faucet rejected the request (see its message above).');
          return done(2);
        case 'no_answer':
          out(
            'No answer from the faucet yet. Check `obbyx balance` in a few minutes or retry later.',
          );
          return done(3);
      }
      done(3);
    },
  };
}
