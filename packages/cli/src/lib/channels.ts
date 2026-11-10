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
  type BatchObyteClientOptions,
  ClientChannelStore,
  closeChannel,
  confirmClose,
  deposit,
  openChannel,
  readChannelState,
  recoverChannels,
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
  declare?: string;
  force?: boolean;
  resend?: boolean;
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
  readonly opts: BatchObyteClientOptions;
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
  recover: recoverCommand,
};

async function openCommand({ args, ctx, opts }: ChannelRun): Promise<void> {
  if (args.target === undefined)
    throw new ObbyxError('usage', 'channel open <seller address> --deposit <GBYTE>');
  if (args.deposit === undefined)
    throw new ObbyxError('usage', 'channel open needs --deposit <GBYTE>');
  const timeout = Number(args.timeout ?? 86_400);
  if (!Number.isInteger(timeout) || timeout < 60)
    throw new ObbyxError('usage', '--window must be ≥ 60 seconds');
  const { aa, unit, outcome } = await openChannel(opts, {
    payTo: args.target,
    deposit: fromDisplay(args.deposit, 9),
    timeout,
  });
  ctx.out(`Channel ${aa} opened to ${args.target}`);
  ctx.out(`  deposit: ${args.deposit} GBYTE, dispute window: ${timeout} s`);
  ctx.out(`  unit: ${unit}\n  ${explorerUnitUrl(ctx.network, unit)}`);
  if (outcome === 'unknown')
    ctx.out('  The hub did not answer: check the unit in the explorer (the channel is recorded).');
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

const LEGACY_NOTE = 'legacy base AA: no longer paid into, close it';

async function listCommand({ ctx, store }: ChannelRun): Promise<void> {
  const all = store.list().filter((c) => c.network === ctx.network.caip2);
  if (all.length === 0)
    ctx.out('No channels. Open one with: obbyx channel open <seller> --deposit <GBYTE>');
  for (const c of all) {
    const flags = [
      c.pending ? 'voucher pending' : '',
      c.lastClose?.period === c.period ? 'closing' : '',
      c.uncertainty ? `signed amount uncertain (${c.uncertainty})` : '',
      c.funded ? '' : 'not funded yet',
      c.legacy ? LEGACY_NOTE : '',
    ].filter((f) => f !== '');
    ctx.out(
      `${c.aa}  seller ${c.payTo}  period ${c.period}  spent ${gbyte(c.committed)}` +
        (flags.length ? `  (${flags.join('; ')})` : ''),
    );
  }
  const legacy = all.filter((c) => c.legacy);
  if (legacy.length)
    ctx.out(
      `${legacy.length} channel(s) on a retired base AA; close them with: obbyx channel close <aa>`,
    );
}

async function statusCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  const v = await readChannelState(opts, ch.aa);
  // Our latest close, while the chain has not moved past its period.
  const close = ch.lastClose && ch.lastClose.period >= (v.period ?? 0) ? ch.lastClose : null;
  ctx.out(`Channel ${ch.aa} → seller ${ch.payTo}`);
  ctx.out(
    `  on-chain: period ${v.period ?? '-'}, deposit ${gbyte(v.balanceB)}` +
      (v.closeInitiatedBy
        ? `, CLOSING (initiated by ${v.closeInitiatedBy === 'A' ? 'seller' : 'you'})`
        : ''),
  );
  ctx.out(
    `  local:    period ${ch.period}, spent ${gbyte(ch.committed)}, highest signed ${gbyte(ch.maxSigned)}` +
      (ch.uncertainty === null ? '' : ` (uncertain: ${UNCERTAINTY[ch.uncertainty]})`) +
      (close
        ? `, close started for period ${close.period}` +
          (close.declared === null ? '' : ` declaring ${gbyte(close.declared)}`) +
          ` (${CLOSE_STATE[close.state]})`
        : ''),
  );
  if (ch.legacy)
    ctx.out(
      `  This channel is on a retired base AA (${ch.baseAa}); close it: obbyx channel close ${ch.aa}`,
    );
  if (ch.pending) {
    ctx.out(
      `  A voucher of ${gbyte(BigInt(ch.pending.amountSpent))} (cumulative) has an unknown outcome.`,
    );
    if (ch.pending.paymentHeader)
      ctx.out(`  Retry that request with: obbyx pay <url> --payment ${ch.pending.paymentHeader}`);
    ctx.out('  Or close the channel: closing declares it, so it is safe.');
  }
  if (v.period === undefined) ctx.out('  The deposit is not credited yet (waiting for stability).');
  else if (v.closeInitiatedBy === 'A')
    ctx.out(`  The seller is closing: confirm at once with: obbyx channel confirm ${ch.aa}`);
  else if (v.closeInitiatedBy === 'B')
    ctx.out(
      `  You are closing: confirm after ${new Date(((v.closeStartTs ?? 0) + ch.timeout) * 1000).toISOString()} with: obbyx channel confirm ${ch.aa}`,
    );
}

const UNCERTAINTY = {
  migrated: 'recorded by an older obbyx version, which may have lost track of vouchers it signed',
  recovered: 'recovered from the chain; vouchers signed from another database are unknown here',
} as const;

const CLOSE_STATE = {
  prepared: 'not sent yet',
  unknown: 'sent, no answer from the hub',
  posted: 'accepted by the hub',
  rejected: 'rejected by the hub: run close again',
} as const;

async function closeCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  // Declares the highest amount ever signed in the on-chain period (a
  // pending voucher included), never less: a seller holding a higher voucher
  // would otherwise take the whole channel with a fraud proof.
  let result;
  try {
    result = await closeChannel(opts, ch.aa, {
      ...(args.declare === undefined ? {} : { declare: fromDisplay(args.declare, 9) }),
      ...(args.force === true ? { force: true } : {}),
      ...(args.resend === true ? { resend: true } : {}),
    });
  } catch (err) {
    if (err instanceof ObbyxError && err.code === 'max_signed_uncertain') {
      const why = err.details?.['reason'] === 'recovered' ? 'recovered' : 'migrated';
      const known = BigInt(String(err.details?.['known'] ?? '0'));
      ctx.out(`WARNING: channel ${ch.aa} was ${UNCERTAINTY[why]}.`);
      ctx.out(
        `  The highest known is ${gbyte(known)}; if more was signed in this period and you declare less, the seller takes the WHOLE deposit.`,
      );
      ctx.out(
        '  Close with --declare <GBYTE> (at least the highest voucher ever signed), or --force to declare the known amount.',
      );
    } else if (err instanceof ObbyxError && err.code === 'broadcast_rejected') {
      ctx.out(
        'The hub rejected the close; nothing changed on-chain. No payments are made from this channel.',
      );
      ctx.out(`Run \`obbyx channel close ${ch.aa}\` again to send it (same or higher --declare).`);
    }
    throw err;
  }
  if (args.force === true && ch.uncertainty !== null)
    ctx.out(`WARNING: --force: declared the highest KNOWN amount; ${UNCERTAINTY[ch.uncertainty]}.`);
  switch (result.kind) {
    case 'requested':
      ctx.out(
        `Close requested for period ${result.period}, declaring ${gbyte(result.declared)} spent: ${result.unit}`,
      );
      if (result.outcome === 'unknown')
        ctx.out(
          `  The hub did not answer: the close may or may not have been accepted (check: obbyx channel status ${ch.aa}).`,
        );
      if (result.previous === 'posted' || result.previous === 'unknown')
        ctx.out(
          '  An earlier close of this period was sent too: whichever lands first applies, the other bounces.',
        );
      ctx.out(
        `The seller confirms at once if this is right; otherwise run \`obbyx channel confirm ${ch.aa}\` after ${ch.timeout} s.`,
      );
      ctx.out('No more payments are made from this channel.');
      return;
    case 'sent_earlier':
      ctx.out(
        `A close for period ${result.period} declaring ${gbyte(result.declared)} was already sent ` +
          `(${CLOSE_STATE[result.state]}), but the chain shows no close pending for period ${result.period}. Nothing was sent now.`,
      );
      ctx.out(
        `It may not be stable yet (check: obbyx channel status ${ch.aa}). If it was lost, send it again with ` +
          `\`obbyx channel close ${ch.aa} --resend\` (it never declares less than ${gbyte(result.declared)}).`,
      );
      return;
    case 'already_closing':
      if (result.by === 'A') {
        ctx.out(`The seller already started closing period ${result.period}.`);
        ctx.out(`Confirm it now to get your balance back: obbyx channel confirm ${ch.aa}`);
      } else {
        ctx.out(`Your close of period ${result.period} is already pending on-chain.`);
        ctx.out(
          `The seller can confirm it at any time; you can from ${new Date(result.confirmableAt * 1000).toISOString()}: obbyx channel confirm ${ch.aa}`,
        );
      }
      return;
  }
}

async function confirmCommand({ args, ctx, store, opts }: ChannelRun): Promise<void> {
  const ch = need(store, args.target);
  const { unit, period } = await confirmClose(opts, ch.aa);
  ctx.out(`Close confirmed for period ${period}: ${unit}`);
}

async function recoverCommand({ ctx, opts }: ChannelRun): Promise<void> {
  const found = await recoverChannels(opts);
  if (found.length === 0) ctx.out('No unrecorded channels found.');
  for (const c of found)
    ctx.out(`Recovered ${c.aa}  seller ${c.payTo}${c.legacy ? `  (${LEGACY_NOTE})` : ''}`);
  if (found.length > 0) {
    ctx.out(
      'WARNING: what was signed on recovered channels is unknown here (another database may have signed vouchers).',
    );
    ctx.out(
      '  Closing one needs --declare <GBYTE> (at least the highest voucher ever signed on it) or --force;',
    );
    ctx.out('  declaring less than any signed voucher lets the seller take the WHOLE deposit.');
  }
}

function need(store: ClientChannelStore, aa: string | undefined) {
  if (aa === undefined) throw new ObbyxError('usage', 'channel address required');
  const ch = store.get(aa);
  if (ch === undefined)
    throw new ObbyxError('no_channel', `Unknown channel ${aa} (see: obbyx channel list)`);
  return ch;
}
