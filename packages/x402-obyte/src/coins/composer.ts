import type obyte from 'obyte';
import { ObbyxError } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import { hubCall } from '../hub/hub-call.js';
import { parseHistory } from '../hub/schemas.js';
import type { CoinReservations } from './reservations.js';
import { type Utxo, inputKey, selectCoins, unspentOutputs } from './selection.js';

/**
 * Input reservation for client-composed units (ADR-0002 "publication").
 *
 * Problem: an `exact` unit is signed by the client but broadcast later by the
 * facilitator. Until the hub knows it, the hub would pick the SAME coins for
 * the next unit → double spend, one unit becomes bad.
 *
 * Solution: our own coin picker, installed on obyte.js's extension point
 * `client.api.pickDivisibleCoinsForAmount`. It computes the wallet's unspent
 * outputs from `light/get_history`, skips reserved ones, reserves what it
 * picks (SQLite, durable) and binds the reservation to the unit hash. Composes
 * per wallet are serialized. A reservation ends when the unit is seen on the
 * ledger (its inputs are then spent for the hub) or, if it never appears, only
 * after `releaseAfterSeconds` (≥ quote validity + the facilitator's publication
 * window) — never earlier, because a signed unit can still be published.
 *
 * Coin rules mirror an ocore light wallet with `spend_unconfirmed: 'own'`:
 * outputs of OTHER authors must be stable and at or before `last_ball_mci`;
 * own unstable outputs (change) may be spent.
 */
export interface ReservingComposerOptions {
  readonly client: obyte.Client;
  readonly network: string;
  readonly address: string;
  readonly reservations: CoinReservations;
  readonly logger: Logger;
  /** Minimum age before an unpublished unit's inputs are released (s). */
  readonly releaseAfterSeconds?: number;
  readonly hubTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Installs the reserving coin picker on an obyte.js client and serializes
 * composes for the wallet. Use `compose(fn)` around every `client.compose.*`.
 */
export class ReservingComposer {
  private queue: Promise<unknown> = Promise.resolve();
  private lastPick: Utxo[] = [];
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly options: ReservingComposerOptions) {
    this.log = moduleLogger(options.logger, 'x402.coins', { address: options.address });
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const api = options.client.api as unknown as Record<string, unknown>;
    api['pickDivisibleCoinsForAmount'] = (params: {
      addresses: string[];
      last_ball_mci: number;
      amount: number;
      asset?: string | null;
    }) => this.pick(params);
  }

  /** Runs `fn` (which composes exactly one unit) with reservations; returns its unit. */
  compose<T extends { unit?: unknown }>(
    fn: () => Promise<T>,
    opts: { holdUntil?: number } = {},
  ): Promise<T> {
    const run = this.queue.then(async () => {
      await this.sweep();
      this.lastPick = [];
      try {
        const unit = await fn();
        const hash = typeof unit.unit === 'string' ? unit.unit : undefined;
        if (hash === undefined) throw new ObbyxError('compose_failed', 'Composed unit has no hash');
        this.options.reservations.bind(this.options.network, this.lastPick, hash, opts.holdUntil);
        this.log.debug({ unit: hash, inputs: this.lastPick.length }, 'inputs reserved for unit');
        return unit;
      } catch (err) {
        this.options.reservations.releaseUnbound(this.options.network, this.lastPick);
        throw err;
      } finally {
        this.lastPick = [];
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Releases the inputs of a unit that was composed but provably never sent anywhere. */
  discard(unit: string): void {
    this.options.reservations.endUnit(this.options.network, unit);
  }

  /** Ends reservations of units now known to the hub, or provably expired. */
  async sweep(): Promise<void> {
    const { reservations, network, client } = this.options;
    const releaseAfter = this.options.releaseAfterSeconds ?? 1200;
    reservations.dropStaleUnbound(network, this.now() - 600);
    for (const { unit, reservedAt, holdUntil } of reservations.boundUnits(network)) {
      const res = await hubCall(
        () => client.api.getJoint(unit),
        this.options.hubTimeoutMs ?? 15_000,
      );
      if (res.kind !== 'ok') return; // unknown: keep everything reserved (fail-safe)
      if (res.value.joint !== undefined) {
        reservations.endUnit(network, unit); // the hub knows the spend now
      } else if (this.now() - reservedAt > releaseAfter && this.now() > (holdUntil ?? 0)) {
        reservations.endUnit(network, unit);
        this.log.info({ unit }, 'unit was never published; inputs released');
      }
    }
  }

  private async pick(params: {
    addresses: string[];
    last_ball_mci: number;
    amount: number;
    asset?: string | null;
  }) {
    const { client, network, address, reservations } = this.options;
    if (params.addresses.length !== 1 || params.addresses[0] !== address) {
      throw new ObbyxError('coins_wrong_address', 'The reserving picker serves a single address');
    }
    const asset = params.asset ?? 'base';
    const t = this.options.hubTimeoutMs ?? 15_000;
    const history = await hubCall(
      () =>
        client.api
          .getWitnesses()
          .then((witnesses) => client.api.getHistory({ witnesses, addresses: [address] } as never)),
      t,
    );
    if (history.kind !== 'ok')
      throw new ObbyxError('ledger_unavailable', `history: ${history.error}`);
    const parsedHistory = parseHistory(history.value);
    if (parsedHistory === undefined)
      throw new ObbyxError('ledger_unavailable', 'history: malformed hub answer');
    const joints = parsedHistory.joints;
    const reserved = reservations.reservedKeys(network);
    const free = unspentOutputs(joints, address, params.last_ball_mci).filter(
      (u) => !reserved.has(inputKey(network, u)),
    );
    const picked = selectCoins(free, asset, BigInt(params.amount));
    if (picked === undefined) {
      throw new ObbyxError(
        'insufficient_funds',
        `Not enough unreserved ${asset} (some coins may be reserved by pending payments)`,
      );
    }
    reservations.reserve(network, address, picked);
    this.lastPick.push(...picked);
    return {
      inputs_with_proofs: picked.map((u) => ({
        input: { unit: u.unit, message_index: u.messageIndex, output_index: u.outputIndex },
      })),
      total_amount: Number(picked.reduce((s, u) => s + u.amount, 0n)),
    };
  }
}
