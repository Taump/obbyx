import type { Argv } from 'yargs';
import { loadWallet } from '@obbyx/obyte/wallet';
import { channelCommand } from '../lib/channels.js';
import type { CommandContext, Cmd, GlobalArgs } from './types.js';
import { cliLogger, connect, reservingComposer, resolveNetwork } from '../runtime.js';

interface ChannelArgs {
  target?: string;
  deposit?: string;
  amount?: string;
  window?: string;
}

/** `obbyx channel <open|list|status|deposit|close|confirm>`. */
export function channelCommands({ out, done }: CommandContext): Cmd<ChannelArgs>[] {
  const channelRun =
    (sub: string) =>
    async (a: GlobalArgs & ChannelArgs): Promise<void> => {
      const network = resolveNetwork(a.network);
      const wallet = loadWallet(network);
      const logger = cliLogger();
      const client = connect(network, a.hub);
      try {
        done(
          await channelCommand(
            {
              sub,
              target: a.target,
              ...(a.deposit === undefined ? {} : { deposit: a.deposit }),
              ...(a.amount === undefined ? {} : { amount: a.amount }),
              ...(a.window === undefined ? {} : { timeout: a.window }),
            },
            {
              network,
              client,
              privateKey: wallet.privateKey,
              logger,
              out,
              composer: reservingComposer(client, network, wallet.address, logger),
            },
          ),
        );
      } finally {
        client.close();
      }
    };
  const aaArg = (y: Argv) =>
    y.positional('target', { type: 'string', demandOption: true, describe: 'Channel AA address' });

  return [
    {
      command: 'open <target>',
      describe: 'Open a payment channel to a seller (instant micropayments)',
      builder: (y) =>
        y
          .positional('target', { type: 'string', demandOption: true, describe: 'Seller address' })
          .option('deposit', { type: 'string', demandOption: true, describe: 'Deposit, GBYTE' })
          .option('window', {
            type: 'string',
            default: '86400',
            describe: 'Dispute window, seconds (sellers require a minimum)',
          }),
      handler: channelRun('open'),
    },
    { command: 'list', describe: 'List your channels', handler: channelRun('list') },
    {
      command: 'status <target>',
      describe: 'Show a channel (balances, spent, period)',
      builder: (y) => aaArg(y),
      handler: channelRun('status'),
    },
    {
      command: 'deposit <target>',
      describe: 'Top up a channel',
      builder: (y) =>
        aaArg(y).option('amount', {
          type: 'string',
          demandOption: true,
          describe: 'Amount, GBYTE',
        }),
      handler: channelRun('deposit'),
    },
    {
      command: 'close <target>',
      describe: 'Start closing a channel (the dispute window begins)',
      builder: (y) => aaArg(y),
      handler: channelRun('close'),
    },
    {
      command: 'confirm <target>',
      describe: 'Finish closing after the dispute window and get the rest back',
      builder: (y) => aaArg(y),
      handler: channelRun('confirm'),
    },
  ];
}
