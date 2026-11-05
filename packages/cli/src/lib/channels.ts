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

interface ChannelArgs {
  sub: string | undefined;
  target: string | undefined;
  deposit?: string;
  amount?: string;
  timeout?: string;
}

interface ChannelContext {
  network: ObyteNetwork;
  client: obyte.Client;
  privateKey: Uint8Array;
  logger: Logger;
  out: (s?: string) => void;
  composer?: ReservingComposer;
}

/** What a subcommand gets: the parsed arguments, the context, the open store and client options. */
interface ChannelRun {
  readonly args: ChannelArgs;
  readonly ctx: ChannelContext;
  readonly store: ClientChannelStore;
  readonly opts: BatchClientOptions;
}

const gbyte = (v: bigint) => `${toDisplay(v, 9)} GBYTE`;

export async function channelCommand(args: ChannelArgs, ctx: ChannelContext): Promise<number> {
  const run = SUBCOMMANDS[args.sub ?? ''];
  if (run === undefined) {
    throw new ObbyxError('usage', `channel ${Object.keys(SUBCOMMANDS).join('|')}`);
  }
  const store = new ClientChannelStore(channelStorePath(ctx.network));
  try {
    await run({
      args,
      ctx,
      store,
      opts: {
        client: ctx.client,
        network: ctx.network,
        privateKey: ctx.privateKey,
        store,
        logger: ctx.logger,
        ...(ctx.composer ? { composer: ctx.composer } : {}),
      },
    });
    return 0;
  } finally {
    store.close();
  }
}

const SUBCOMMANDS: Record<string, (run: ChannelRun) => Promise<void>> = {
  open: openCommand,
  deposit: depositCommand,
  list: listCommand,
  status: statusCommand,
  close: closeCommand,
  confirm: confirmCommand,
};

async function openCommand({ args, ctx, opts }: ChannelRun): Promise<void> {
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
  ctx.out(`Channel ${aa} opened to ${args.target}`);
  ctx.out(`  deposit: ${args.deposit} GBYTE, dispute window: ${timeout} s`);
  ctx.out(`  unit: ${unit}\n  ${explorerUnitUrl(ctx.network, unit)}`);
  ctx.out(
    'Usable once the deposit is stable (minutes under load, up to ~2 h when the network is quiet): obbyx channel status ' +
      aa,
  );
}

async function depositCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  if (args.amount === undefined)
    throw new ObbyxError('usage', 'channel deposit <aa> --amount <GBYTE>');
  const unit = await deposit(opts, ch.aa, fromDisplay(args.amount, 9));
  ctx.out(`Deposited ${args.amount} GBYTE to ${ch.aa}: ${unit}`);
}

async function listCommand({ ctx, store }: ChannelRun): Promise<void> {
  const all = store.list().filter((c) => c.network === ctx.network.caip2);
  if (all.length === 0)
    ctx.out('No channels. Open one with: obbyx channel open <seller> --deposit <GBYTE>');
  for (const c of all) {
    ctx.out(
      `${c.aa}  seller ${c.payTo}  period ${c.period}  spent ${gbyte(c.committed)}${c.pending ? '  (voucher pending)' : ''}`,
    );
  }
}

async function statusCommand({ args, ctx, store }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  const vars = await hubCall(() => ctx.client.api.getAaStateVars({ address: ch.aa }), 15_000);
  if (vars.kind !== 'ok') throw new ObbyxError('ledger_unavailable', vars.error);
  const v = vars.value as Record<string, number | string | undefined>;
  ctx.out(`Channel ${ch.aa} → seller ${ch.payTo}`);
  ctx.out(
    `  on-chain: period ${v['period'] ?? '-'}, deposit ${gbyte(BigInt(Number(v['balanceB'] ?? 0)))}` +
      (v['close_initiated_by']
        ? `, CLOSING (initiated by ${v['close_initiated_by'] === 'A' ? 'seller' : 'you'})`
        : ''),
  );
  ctx.out(
    `  local:    period ${ch.period}, spent ${gbyte(ch.committed)}${ch.pending ? `, pending voucher ${ch.pending.amountSpent}` : ''}`,
  );
  if (v['period'] === undefined)
    ctx.out('  The deposit is not credited yet (waiting for stability).');
}

async function closeCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  if (ch.pending) {
    throw new ObbyxError(
      'payment_pending',
      'A voucher has an unknown outcome; retry that request before closing',
    );
  }
  // Declare the highest amount we ever signed, not the last confirmed one: a
  // seller holding a higher voucher would otherwise take the whole channel
  // with a fraud proof. At worst this pays for one unserved request.
  const unit = await closeChannel(opts, ch.aa, ch.period, ch.maxSigned);
  ctx.out(
    `Close requested for period ${ch.period}, declaring ${gbyte(ch.maxSigned)} spent: ${unit}`,
  );
  ctx.out(
    `The seller confirms at once if this is right; otherwise run \`obbyx channel confirm ${ch.aa}\` after ${ch.timeout} s.`,
  );
}

async function confirmCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  const unit = await confirmClose(opts, ch.aa, ch.period);
  ctx.out(`Close confirmed for period ${ch.period}: ${unit}`);
}

function need(store: ClientChannelStore, aa: string | undefined) {
  if (aa === undefined) throw new ObbyxError('usage', 'channel address required');
  const ch = store.get(aa);
  if (ch === undefined)
    throw new ObbyxError('no_channel', `Unknown channel ${aa} (see: obbyx channel list)`);
  return ch;
}
