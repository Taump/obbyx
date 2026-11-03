import { createWallet, walletPath } from '@obbyx/obyte/wallet';
import { resolveNetwork } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function initCommand({ out, done }: CommandContext): Cmd<{ force: boolean }> {
  return {
    command: 'init',
    describe: 'Create a local wallet',
    builder: (y) =>
      y.option('force', {
        type: 'boolean',
        default: false,
        describe: 'Overwrite an existing wallet',
      }),
    handler: (a) => {
      const network = resolveNetwork(a.network);
      const wallet = createWallet(network, { force: a.force });
      out(`Wallet created for ${network.caip2}`);
      out(`  address: ${wallet.address}`);
      out(`  file:    ${walletPath(network)} (keep it private; it holds your key)`);
      if (network.testnet) {
        out();
        out('Fund it with testnet bytes: obbyx faucet (then: obbyx balance)');
      }
      done(0);
    },
  };
}
