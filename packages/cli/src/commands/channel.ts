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
  declare?: string;
  force?: boolean;
  resend?: boolean;
}

/** `obbyx channel <open|list|status|deposit|close|confirm|recover>`. */
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
              ...(a.declare === undefined ? {} : { declare: a.declare }),
              ...(a.force === undefined ? {} : { force: a.force }),
              ...(a.resend === undefined ? {} : { resend: a.resend }),
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
      describe:
        'Start closing a channel (the dispute window begins). Declares the highest amount you ever ' +
        'signed in the current on-chain period (a pending voucher included) and stops paying from it. ' +
        'If the seller already started a close, it tells you to confirm instead.',
      builder: (y) =>
        aaArg(y)
          .option('declare', {
            type: 'string',
            describe:
              'Declare this amount spent, GBYTE (never below what you are known to have signed). ' +
              'Required, or --force, for a channel recorded by obbyx 0.1.5 or earlier (it may have ' +
              'lost track of vouchers it signed) or found by `channel recover`: declaring ' +
              'less than any voucher lets the seller take the whole deposit. On a repeated close it ' +
              'can only raise an earlier declaration that was sent',
          })
          .option('force', {
            type: 'boolean',
            describe:
              'For such a channel: declare the highest KNOWN amount anyway (only if you are sure no ' +
              'larger voucher was signed)',
          })
          .option('resend', {
            type: 'boolean',
            describe:
              'Send again a close that was sent earlier but never appeared on-chain (not needed when ' +
              'the hub rejected it or it was never sent)',
          }),
      handler: channelRun('close'),
    },
    {
      command: 'confirm <target>',
      describe:
        'Finish closing and get the rest back: at once when the seller started the close, after the dispute window when you did',
      builder: (y) => aaArg(y),
      handler: channelRun('confirm'),
    },
    {
      command: 'recover',
      describe:
        'Find channels you opened that are missing from the local database (e.g. after a crash) and record them. ' +
        'What was signed on them is unknown, so closing one needs --declare or --force',
      handler: channelRun('recover'),
    },
  ];
}
