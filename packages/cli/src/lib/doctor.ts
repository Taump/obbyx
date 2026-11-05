import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import obyte from 'obyte';
import { type ObyteNetwork, toDisplay } from '@obbyx/obyte';
import { ClientChannelStore, CoinReservations, hubCall, parseBalances } from '@obbyx/x402-obyte';
import { channelStorePath } from './channels.js';
import { obbyxHome, walletPath } from '@obbyx/obyte/wallet';

/**
 * `obbyx doctor` — checks everything a payment depends on and says what to fix.
 * Exit code 0 when nothing failed (warnings allowed).
 */
type Status = 'ok' | 'warn' | 'fail';
type Report = (status: Status, what: string, detail?: string) => void;

const MARK: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };
const HUB_TIMEOUT_MS = 10_000;

export async function doctor(
  network: ObyteNetwork,
  opts: { hub?: string; facilitator?: string; out: (s: string) => void },
): Promise<number> {
  const results: Status[] = [];
  const report: Report = (status, what, detail = '') => {
    results.push(status);
    opts.out(`${MARK[status]} ${what}${detail ? ` — ${detail}` : ''}`);
  };
  const address = checkWallet(network, report);
  await checkHub(network, opts.hub ?? network.defaultHubUrl, address, report);
  checkLocalState(network, report);
  if (opts.facilitator !== undefined) await checkFacilitator(network, opts.facilitator, report);
  return results.includes('fail') ? 1 : 0;
}

/** The wallet file exists and only its owner can read it; returns its address. */
function checkWallet(network: ObyteNetwork, report: Report): string | undefined {
  const wallet = walletPath(network);
  if (!existsSync(wallet)) {
    report('fail', 'wallet', `missing; run: obbyx init --network ${network.name}`);
    return undefined;
  }
  if ((statSync(wallet).mode & 0o077) !== 0) {
    report('fail', 'wallet', `${wallet} is readable by others; run: chmod 600 ${wallet}`);
    return undefined;
  }
  const address = (JSON.parse(readFileSync(wallet, 'utf8')) as { address: string }).address;
  report('ok', 'wallet', `${address} (${wallet})`);
  return address;
}

/** The hub answers; then the wallet's bytes balance (empty on testnet is only a warning). */
async function checkHub(
  network: ObyteNetwork,
  hubUrl: string,
  address: string | undefined,
  report: Report,
): Promise<void> {
  const client = new obyte.Client(hubUrl, { testnet: network.testnet });
  try {
    const started = Date.now();
    const mci = await hubCall(() => client.api.getLastMci(), HUB_TIMEOUT_MS);
    if (mci.kind !== 'ok') {
      report('fail', 'hub', `${hubUrl}: ${mci.error}`);
      return;
    }
    report('ok', 'hub', `${hubUrl}, last MCI ${mci.value}, ${Date.now() - started} ms`);
    if (address === undefined) return;
    const b = await hubCall(() => client.api.getBalances([address]), HUB_TIMEOUT_MS);
    if (b.kind !== 'ok') {
      report('warn', 'balance', b.error);
      return;
    }
    const base = parseBalances(b.value, address)?.['base'];
    const stable = base?.stable ?? 0n;
    const pending = base?.pending ?? 0n;
    const empty = stable === 0n;
    report(
      empty ? (network.testnet ? 'warn' : 'fail') : 'ok',
      'balance',
      `${toDisplay(stable, 9)} GBYTE stable, ${toDisplay(pending, 9)} pending` +
        (empty && network.testnet ? '; run: obbyx faucet' : ''),
    );
  } finally {
    client.close();
  }
}

/** Coin reservations and channels with an unknown outcome (warnings, never failures). */
function checkLocalState(network: ObyteNetwork, report: Report): void {
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
}

/** The facilitator answers /supported and serves this network. */
async function checkFacilitator(
  network: ObyteNetwork,
  facilitator: string,
  report: Report,
): Promise<void> {
  try {
    const res = await fetch(new URL('/supported', facilitator), {
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    const supported = (await res.json()) as { kinds?: { scheme: string; network: string }[] };
    const kinds = (supported.kinds ?? [])
      .filter((k) => k.network === network.caip2)
      .map((k) => k.scheme);
    report(
      kinds.length > 0 ? 'ok' : 'fail',
      'facilitator',
      kinds.length > 0 ? `${facilitator}: ${kinds.join(', ')}` : `does not serve ${network.caip2}`,
    );
  } catch (err) {
    report(
      'fail',
      'facilitator',
      `${facilitator}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
