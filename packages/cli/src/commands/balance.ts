import { ObbyxError, toDisplay } from '@obbyx/obyte';
import { parseBalances } from '@obbyx/x402-obyte';
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
        const mine = parseBalances(await client.api.getBalances([wallet.address]), wallet.address);
        if (mine === undefined) throw new ObbyxError('ledger_unavailable', 'Malformed balances');
        const bytes = mine['base'] ?? { stable: 0n, pending: 0n };
        out(`${wallet.address} on ${network.caip2}`);
        out(
          `  GBYTE: ${toDisplay(bytes.stable, 9)} stable, ${toDisplay(bytes.pending, 9)} pending`,
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
