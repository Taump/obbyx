import { toDisplay } from '@obbyx/obyte';
import { loadWallet } from '@obbyx/obyte/wallet';
import { connect, resolveNetwork } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function balanceCommand({ out, done }: CommandContext): Cmd {
  return {
    command: 'balance',
    describe: 'Show your balance',
    handler: async (a) => {
      const network = resolveNetwork(a.network);
      const wallet = loadWallet(network);
      const client = connect(network, a.hub);
      try {
        const balances = (await client.api.getBalances([wallet.address])) as Record<
          string,
          Record<string, { stable: number; pending: number }>
        >;
        const mine = balances[wallet.address] ?? {};
        const bytes = mine['base'] ?? { stable: 0, pending: 0 };
        out(`${wallet.address} on ${network.caip2}`);
        out(
          `  GBYTE: ${toDisplay(BigInt(bytes.stable), 9)} stable, ${toDisplay(BigInt(bytes.pending), 9)} pending`,
        );
        for (const [asset, b] of Object.entries(mine)) {
          if (asset !== 'base')
            out(`  ${asset}: ${b.stable} stable, ${b.pending} pending (atomic units)`);
        }
      } finally {
        client.close();
      }
      done(0);
    },
  };
}
