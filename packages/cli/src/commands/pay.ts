import { ObbyxError, fromDisplay } from '@obbyx/obyte';
import { loadWallet } from '@obbyx/obyte/wallet';
import { BatchObyteClient, ClientChannelStore, ExactObyteClient } from '@obbyx/x402-obyte';
import { PaymentPendingError, payingFetch } from '@obbyx/sdk';
import { channelStorePath } from '../lib/channels.js';
import {
  bytesArg,
  cliLogger,
  connect,
  printPayment,
  reservingComposer,
  resolveNetwork,
  seconds,
} from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

interface PayArgs {
  url: string;
  max: string;
  method?: string;
  data?: string;
  header?: string[];
  payment?: string;
  wait: string;
  'max-fee': string;
}
export function payCommand({ out, err, done }: CommandContext): Cmd<PayArgs> {
  return {
    command: 'pay <url>',
    describe: 'Call a paid API, paying at most --max',
    builder: (y) =>
      y
        .positional('url', { type: 'string', demandOption: true, describe: 'URL of the paid API' })
        .option('max', {
          type: 'string',
          demandOption: 'pay needs --max <GBYTE>: the most you allow this call to cost',
          describe: 'Spending limit for this call, in GBYTE (e.g. 0.00002)',
        })
        .option('method', {
          type: 'string',
          describe: 'HTTP method (default GET, or POST with --data)',
        })
        .option('data', { type: 'string', describe: 'Request body (JSON by default)' })
        .option('header', {
          type: 'string',
          array: true,
          describe: "Extra header 'Name: value' (repeatable)",
        })
        .option('payment', {
          type: 'string',
          describe: 'Retry a pending request with the same payment (printed by pay)',
        })
        .option('wait', {
          type: 'string',
          default: '600',
          describe:
            'How long to wait for the payment to become final, seconds (testnet can take minutes). It never pays twice meanwhile.',
        })
        .option('max-fee', {
          type: 'string',
          default: '10000',
          describe: 'Most network fee (bytes) an on-chain (exact) payment may cost',
        }),
    handler: async (a) => {
      const network = resolveNetwork(a.network);
      // Validate every argument before touching the wallet or the network.
      const max = fromDisplay(a.max, 9);
      const maxFee = bytesArg(a['max-fee'], 'max-fee');
      const waitMs = seconds(a.wait, 'wait') * 1000;
      const wallet = loadWallet(network);
      const logger = cliLogger();
      const client = connect(network, a.hub);
      try {
        const composer = reservingComposer(client, network, wallet.address, logger);
        const mechanism = new ExactObyteClient({
          client,
          network: network.caip2,
          privateKey: wallet.privateKey,
          logger,
          composer,
          maxFee,
        });
        // Use a payment channel to this seller when one is open (instant, no fee per call).
        const batch = new BatchObyteClient({
          client,
          network,
          privateKey: wallet.privateKey,
          store: new ClientChannelStore(channelStorePath(network)),
          logger,
          maxAmount: new Map([['base', max]]),
          composer,
        });
        const headers: Record<string, string> = {};
        for (const h of a.header ?? []) {
          const i = h.indexOf(':');
          if (i <= 0) throw new ObbyxError('usage', `Bad --header "${h}" (expected "Name: value")`);
          headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
        }
        if (a.data !== undefined) headers['content-type'] ??= 'application/json';
        const method = a.method ?? (a.data === undefined ? 'GET' : 'POST');
        try {
          const result = await payingFetch(
            a.url,
            {
              method,
              headers,
              ...(a.data === undefined ? {} : { body: a.data }),
              ...(a.payment === undefined ? {} : { paymentHeader: a.payment }),
            },
            {
              mechanisms: { exact: mechanism, batch },
              network: network.caip2,
              maxAmount: new Map([['base', max]]),
              logger,
              pendingTimeoutMs: waitMs,
            },
          );
          err(`HTTP ${result.response.status}`);
          if (result.payment) printPayment(err, network, result.payment);
          out(await result.response.text());
          return done(result.response.ok ? 0 : 2);
        } catch (e) {
          if (e instanceof PaymentPendingError) {
            err(`Payment ${e.transaction} is not final yet. Retry the same request later with:`);
            err(`  --payment ${e.paymentHeader}`);
            return done(3);
          }
          throw e;
        }
      } finally {
        client.close();
      }
    },
  };
}
