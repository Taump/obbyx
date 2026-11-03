import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import obyte from 'obyte';
import { type ObyteNetwork, toDisplay } from '@obbyx/obyte';
import { ClientChannelStore, CoinReservations, hubCall } from '@obbyx/x402-obyte';
import { channelStorePath } from './channels.js';
import { obbyxHome, walletPath } from '@obbyx/obyte/wallet';

/**
 * `obbyx doctor` — checks everything a payment depends on and says what to fix.
 * Exit code 0 when nothing failed (warnings allowed).
 */
type Status = 'ok' | 'warn' | 'fail';

export async function doctor(
  network: ObyteNetwork,
  opts: { hub?: string; facilitator?: string; out: (s: string) => void },
): Promise<number> {
  const results: Status[] = [];
  const report = (status: Status, what: string, detail = '') => {
    results.push(status);
    opts.out(
      `${status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`,
    );
  };

  // Wallet
  const wallet = walletPath(network);
  let address: string | undefined;
  if (!existsSync(wallet)) {
    report('fail', 'wallet', `missing; run: obbyx init --network ${network.name}`);
  } else if ((statSync(wallet).mode & 0o077) !== 0) {
    report('fail', 'wallet', `${wallet} is readable by others; run: chmod 600 ${wallet}`);
  } else {
    const { readFileSync } = await import('node:fs');
    address = (JSON.parse(readFileSync(wallet, 'utf8')) as { address: string }).address;
    report('ok', 'wallet', `${address} (${wallet})`);
  }

  // Hub
  const client = new obyte.Client(opts.hub ?? network.defaultHubUrl, { testnet: network.testnet });
  try {
    const started = Date.now();
    const mci = await hubCall(() => client.api.getLastMci(), 10_000);
    if (mci.kind !== 'ok') {
      report('fail', 'hub', `${opts.hub ?? network.defaultHubUrl}: ${mci.error}`);
    } else {
      report(
        'ok',
        'hub',
        `${opts.hub ?? network.defaultHubUrl}, last MCI ${mci.value}, ${Date.now() - started} ms`,
      );
      if (address !== undefined) {
        const b = await hubCall(() => client.api.getBalances([address]), 10_000);
        if (b.kind === 'ok') {
          const base = (
            b.value as Record<string, Record<string, { stable: number; pending: number }>>
          )[address]?.['base'];
          const stable = BigInt(base?.stable ?? 0);
          const pending = BigInt(base?.pending ?? 0);
          report(
            stable === 0n ? (network.testnet ? 'warn' : 'fail') : 'ok',
            'balance',
            `${toDisplay(stable, 9)} GBYTE stable, ${toDisplay(pending, 9)} pending` +
              (stable === 0n && network.testnet ? '; run: obbyx faucet' : ''),
          );
        } else {
          report('warn', 'balance', b.error);
        }
      }
    }
  } finally {
    client.close();
  }

  // Local payment state
  const coinsPath = join(obbyxHome(), `coins-${network.name}.db`);
  if (existsSync(coinsPath)) {
    const reservations = new CoinReservations(coinsPath);
    const units = reservations.boundUnits(network.caip2);
    reservations.close();
    report(
      units.length === 0 ? 'ok' : 'warn',
      'coin reservations',
      units.length === 0
        ? 'none'
        : `${units.length} unpublished payment unit(s) hold inputs; they are released once seen on the ledger or after the publication window`,
    );
  }
  const channelsPath = channelStorePath(network);
  if (existsSync(channelsPath)) {
    const channels = new ClientChannelStore(channelsPath);
    const list = channels.list().filter((c) => c.network === network.caip2);
    channels.close();
    const pending = list.filter((c) => c.pending !== null);
    report(
      pending.length === 0 ? 'ok' : 'warn',
      'channels',
      `${list.length} channel(s)` +
        (pending.length
          ? `, ${pending.length} with a voucher of unknown outcome (retry that request with --payment)`
          : ''),
    );
  }

  // Facilitator (optional)
  if (opts.facilitator !== undefined) {
    try {
      const res = await fetch(new URL('/supported', opts.facilitator), {
        signal: AbortSignal.timeout(10_000),
      });
      const supported = (await res.json()) as { kinds?: { scheme: string; network: string }[] };
      const kinds = (supported.kinds ?? [])
        .filter((k) => k.network === network.caip2)
        .map((k) => k.scheme);
      report(
        kinds.length > 0 ? 'ok' : 'fail',
        'facilitator',
        kinds.length > 0
          ? `${opts.facilitator}: ${kinds.join(', ')}`
          : `does not serve ${network.caip2}`,
      );
    } catch (err) {
      report(
        'fail',
        'facilitator',
        `${opts.facilitator}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return results.includes('fail') ? 1 : 0;
}
