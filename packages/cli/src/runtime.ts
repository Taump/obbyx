import { join } from 'node:path';
import obyte from 'obyte';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import {
  OBYTE_NETWORKS,
  ObbyxError,
  type ObyteNetwork,
  explorerUnitUrl,
  getNetwork,
  toDisplay,
} from '@obbyx/obyte';
import { type Logger, createLogger } from '@obbyx/obyte/logger';
import { obbyxHome } from '@obbyx/obyte/wallet';
import { CoinReservations, ReservingComposer } from '@obbyx/x402-obyte';
import pinoPretty from 'pino-pretty';

/** Helpers shared by the commands: network/hub, logger, argument parsing, output. */
export function printPayment(
  err: (l: string) => void,
  network: ObyteNetwork,
  p: {
    success: boolean;
    amount?: string;
    transaction: string;
    errorReason?: string;
    extra?: unknown;
  },
): void {
  const channel = p.extra as
    | {
        chargedAmount?: string;
        channelState?: { channelId?: string; chargedCumulativeAmount?: string };
      }
    | undefined;
  if (p.success && channel?.chargedAmount !== undefined) {
    // batch-settlement: an off-chain voucher, no unit per call.
    err(
      `Paid: ${toDisplay(BigInt(channel.chargedAmount), 9)} GBYTE via channel ${channel.channelState?.channelId ?? ''}` +
        ` (total in this period: ${toDisplay(BigInt(channel.channelState?.chargedCumulativeAmount ?? '0'), 9)} GBYTE)`,
    );
  } else if (p.success) {
    err(
      `Paid: ${toDisplay(BigInt(p.amount ?? '0'), 9)} GBYTE, unit ${p.transaction}\n  ${explorerUnitUrl(network, p.transaction)}`,
    );
  } else {
    err(`Payment not completed: ${p.errorReason}${p.transaction ? ` (${p.transaction})` : ''}`);
  }
}

/**
 * Logs of the CLI go to stderr (stdout carries the command's result, e.g. the
 * paid API's answer), human-readable in a terminal. The formatter is built
 * here from the CLI's own dependency, not loaded by name in a worker.
 */
export function cliLogger(): Logger {
  return createLogger({
    level: (process.env['LOG_LEVEL'] as never) ?? 'warn',
    destination: process.stderr.isTTY
      ? pinoPretty({ colorize: true, destination: 2, sync: true })
      : process.stderr,
  });
}

export function bytesArg(value: string, name: string): bigint {
  if (!/^\d+$/.test(value))
    throw new ObbyxError('usage', `--${name} must be a whole number of bytes`);
  return BigInt(value);
}

export function seconds(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 86_400) {
    throw new ObbyxError('usage', `--${name} must be a whole number of seconds (1..86400)`);
  }
  return n;
}

/** Reserving coin picker for this wallet (inputs of unpublished units are never reused). */
export function reservingComposer(
  client: obyte.Client,
  network: ObyteNetwork,
  address: string,
  logger: Logger,
): ReservingComposer {
  return new ReservingComposer({
    client,
    network: network.caip2,
    address,
    reservations: new CoinReservations(join(obbyxHome(), `coins-${network.name}.db`)),
    logger,
  });
}

export function resolveNetwork(name: string): ObyteNetwork {
  if (name === 'testnet' || name === 'livenet') return OBYTE_NETWORKS[name];
  try {
    return getNetwork(name);
  } catch {
    throw new ObbyxError('usage', `Unknown --network "${name}" (use testnet or livenet)`);
  }
}

export function connect(network: ObyteNetwork, hub: string | undefined): obyte.Client {
  return new obyte.Client(hub ?? network.defaultHubUrl, { testnet: network.testnet });
}

export function decodeAny(value: string): unknown {
  for (const [kind, decode] of [
    ['PAYMENT-SIGNATURE', decodePaymentSignatureHeader],
    ['PAYMENT-REQUIRED', decodePaymentRequiredHeader],
    ['PAYMENT-RESPONSE', decodePaymentResponseHeader],
  ] as const) {
    try {
      const decoded = decode(value) as Record<string, unknown>;
      const looksRight =
        kind === 'PAYMENT-SIGNATURE'
          ? 'payload' in decoded && 'accepted' in decoded
          : kind === 'PAYMENT-REQUIRED'
            ? 'accepts' in decoded
            : 'success' in decoded;
      if (looksRight) return { header: kind, value: decoded };
    } catch {
      // try next
    }
  }
  throw new ObbyxError('decode_failed', 'Not a recognizable x402 header');
}
