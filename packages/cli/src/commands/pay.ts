import type obyte from 'obyte';
import { ObbyxError, type ObyteNetwork, fromDisplay } from '@obbyx/obyte';
import type { Logger } from '@obbyx/obyte/logger';
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
        const headers = parseHeaders(a.header ?? [], a.data !== undefined);
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
              mechanisms: mechanisms({ client, network, wallet, max, maxFee, logger }),
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

/** `--header 'Name: value'` options; a body defaults to JSON. */
function parseHeaders(list: readonly string[], hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of list) {
    const i = h.indexOf(':');
    if (i <= 0) throw new ObbyxError('usage', `Bad --header "${h}" (expected "Name: value")`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (hasBody) headers['content-type'] ??= 'application/json';
  return headers;
}

/**
 * The wallet's payment mechanisms: an open channel to the seller first
 * (instant, no fee per call), otherwise an on-chain unit. One coin composer
 * for both, so concurrent payments never pick the same coins.
 */
function mechanisms({
  client,
  network,
  wallet,
  max,
  maxFee,
  logger,
}: {
  client: obyte.Client;
  network: ObyteNetwork;
  wallet: { address: string; privateKey: Uint8Array };
  /** Most this call may cost (atomic units of bytes). */
  max: bigint;
  /** Most network fee an on-chain payment may cost (bytes). */
  maxFee: bigint;
  logger: Logger;
}): { exact: ExactObyteClient; batch: BatchObyteClient } {
  const composer = reservingComposer(client, network, wallet.address, logger);
  return {
    exact: new ExactObyteClient({
      client,
      network: network.caip2,
      privateKey: wallet.privateKey,
      logger,
      composer,
      maxFee,
    }),
    batch: new BatchObyteClient({
      client,
      network,
      privateKey: wallet.privateKey,
      store: new ClientChannelStore(channelStorePath(network)),
      logger,
      maxAmount: new Map([['base', max]]),
      composer,
    }),
  };
}
