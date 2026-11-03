import { join } from 'node:path';
import type obyte from 'obyte';
import {
  ObbyxError,
  type ObyteNetwork,
  explorerUnitUrl,
  fromDisplay,
  toDisplay,
} from '@obbyx/obyte';
import type { Logger } from '@obbyx/obyte/logger';
import {
  type BatchClientOptions,
  ClientChannelStore,
  closeChannel,
  confirmClose,
  deposit,
  hubCall,
  openChannel,
  type ReservingComposer,
} from '@obbyx/x402-obyte';
import { obbyxHome } from '@obbyx/obyte/wallet';

/**
 * `obbyx channel …` — the buyer's AA payment channels (party B).
 * State lives in `$OBBYX_HOME/channels-<network>.db`.
 */
export function channelStorePath(
  network: ObyteNetwork,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(obbyxHome(env), `channels-${network.name}.db`);
}

export async function channelCommand(
  args: {
    sub: string | undefined;
    target: string | undefined;
    deposit?: string;
    amount?: string;
    timeout?: string;
  },
  ctx: {
    network: ObyteNetwork;
    client: obyte.Client;
    privateKey: Uint8Array;
    logger: Logger;
    out: (s?: string) => void;
    composer?: ReservingComposer;
  },
): Promise<number> {
  const store = new ClientChannelStore(channelStorePath(ctx.network));
  const opts: BatchClientOptions = {
    client: ctx.client,
    network: ctx.network,
    privateKey: ctx.privateKey,
    store,
    logger: ctx.logger,
    ...(ctx.composer ? { composer: ctx.composer } : {}),
  };
  const { out } = ctx;
  const gbyte = (v: bigint) => `${toDisplay(v, 9)} GBYTE`;
  try {
    switch (args.sub) {
      case 'open': {
        if (args.target === undefined)
          throw new ObbyxError('usage', 'channel open <seller address> --deposit <GBYTE>');
        if (args.deposit === undefined)
          throw new ObbyxError('usage', 'channel open needs --deposit <GBYTE>');
        const timeout = Number(args.timeout ?? 86_400);
        if (!Number.isInteger(timeout) || timeout < 60)
          throw new ObbyxError('usage', '--window must be ≥ 60 seconds');
        const { aa, unit } = await openChannel(opts, {
          payTo: args.target,
          deposit: fromDisplay(args.deposit, 9),
          timeout,
        });
        out(`Channel ${aa} opened to ${args.target}`);
        out(`  deposit: ${args.deposit} GBYTE, dispute window: ${timeout} s`);
        out(`  unit: ${unit}\n  ${explorerUnitUrl(ctx.network, unit)}`);
        out(
          'Usable once the deposit is stable (minutes under load, up to ~2 h when the network is quiet): obbyx channel status ' +
            aa,
        );
        return 0;
      }
      case 'deposit': {
        const ch = need(store, args.target);
        if (args.amount === undefined)
          throw new ObbyxError('usage', 'channel deposit <aa> --amount <GBYTE>');
        const unit = await deposit(opts, ch.aa, fromDisplay(args.amount, 9));
        out(`Deposited ${args.amount} GBYTE to ${ch.aa}: ${unit}`);
        return 0;
      }
      case 'list': {
        const all = store.list().filter((c) => c.network === ctx.network.caip2);
        if (all.length === 0)
          out('No channels. Open one with: obbyx channel open <seller> --deposit <GBYTE>');
        for (const c of all) {
          out(
            `${c.aa}  seller ${c.payTo}  period ${c.period}  spent ${gbyte(c.committed)}${c.pending ? '  (voucher pending)' : ''}`,
          );
        }
        return 0;
      }
      case 'status': {
        const ch = need(store, args.target);
        const vars = await hubCall(() => ctx.client.api.getAaStateVars({ address: ch.aa }), 15_000);
        if (vars.kind !== 'ok') throw new ObbyxError('ledger_unavailable', vars.error);
        const v = vars.value as Record<string, number | string | undefined>;
        out(`Channel ${ch.aa} → seller ${ch.payTo}`);
        out(
          `  on-chain: period ${v['period'] ?? '-'}, deposit ${gbyte(BigInt(Number(v['balanceB'] ?? 0)))}` +
            (v['close_initiated_by']
              ? `, CLOSING (initiated by ${v['close_initiated_by'] === 'A' ? 'seller' : 'you'})`
              : ''),
        );
        out(
          `  local:    period ${ch.period}, spent ${gbyte(ch.committed)}${ch.pending ? `, pending voucher ${ch.pending.amountSpent}` : ''}`,
        );
        if (v['period'] === undefined)
          out('  The deposit is not credited yet (waiting for stability).');
        return 0;
      }
      case 'close': {
        const ch = need(store, args.target);
        if (ch.pending) {
          throw new ObbyxError(
            'payment_pending',
            'A voucher has an unknown outcome; retry that request before closing',
          );
        }
        const unit = await closeChannel(opts, ch.aa, ch.period, ch.committed);
        out(
          `Close requested for period ${ch.period}, declaring ${gbyte(ch.committed)} spent: ${unit}`,
        );
        out(
          `The seller confirms at once if this is right; otherwise run \`obbyx channel confirm ${ch.aa}\` after ${ch.timeout} s.`,
        );
        return 0;
      }
      case 'confirm': {
        const ch = need(store, args.target);
        const unit = await confirmClose(opts, ch.aa, ch.period);
        out(`Close confirmed for period ${ch.period}: ${unit}`);
        return 0;
      }
      default:
        throw new ObbyxError('usage', 'channel open|deposit|list|status|close|confirm');
    }
  } finally {
    store.close();
  }
}

function need(store: ClientChannelStore, aa: string | undefined) {
  if (aa === undefined) throw new ObbyxError('usage', 'channel address required');
  const ch = store.get(aa);
  if (ch === undefined)
    throw new ObbyxError('no_channel', `Unknown channel ${aa} (see: obbyx channel list)`);
  return ch;
}
