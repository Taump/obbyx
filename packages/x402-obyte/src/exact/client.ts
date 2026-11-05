import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';
import { ObbyxError, toSafeNumber } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type obyte from 'obyte';
import type { ReservingComposer } from '../coins/index.js';
import { type PaymentRequirementsV1, requirementsV1ToV2 } from './facilitator-v1.js';
import {
  EXACT_SCHEME,
  type ParsedExactRequirements,
  parseExactRequirements,
} from './requirements.js';

/**
 * Client side of `exact` on Obyte: composes and signs (but does NOT
 * broadcast) a unit paying `payTo` with the seller's binding in a data
 * message — obyte.js `client.compose.message` used directly.
 *
 * With a `composer` (ReservingComposer) inputs are reserved per payment and
 * composes are serialized, so concurrent payments never pick the same coins.
 */
export interface ExactObyteClientOptions {
  /** obyte.js client connected to a hub of `network`. */
  readonly client: obyte.Client;
  readonly network: string;
  readonly privateKey: Uint8Array;
  readonly logger: Logger;
  /** Refuse requirements above this amount (atomic units) per asset. */
  readonly maxAmount?: ReadonlyMap<string, bigint>;
  /** Reserves inputs and serializes composes (strongly recommended; see coins.ts). */
  readonly composer?: ReservingComposer;
  /** Refuse units whose network fees (headers + payload + tps) exceed this (bytes). */
  readonly maxFee?: bigint;
}

/**
 * Inputs of a signed unit stay reserved at least until the offer expires plus
 * this margin (covers the facilitator's default publication window). An Obyte
 * unit never expires, so any release is a heuristic; releasing too early can
 * only make a LATER payment of ours fail (one of two units spending the same
 * input becomes final-bad), it cannot pay twice.
 */
const PUBLICATION_MARGIN_SECONDS = 900;

export class ExactObyteClient implements SchemeNetworkClient {
  readonly scheme = EXACT_SCHEME;
  private readonly log: Logger;

  constructor(private readonly options: ExactObyteClientOptions) {
    this.log = moduleLogger(options.logger, 'x402.exact.client');
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const req = this.acceptable(x402Version, requirements, context);
    const unit = await this.signUnit(req);
    this.log.info(
      {
        proofId: unit['unit'],
        payTo: req.payTo,
        asset: req.asset,
        amount: req.amount.toString(),
        binding: req.extra.binding,
      },
      'payment unit signed (not broadcast)',
    );
    // v1: the mechanism returns the complete payload (core passes it through as-is).
    if (x402Version === 1) {
      return {
        x402Version: 1,
        scheme: EXACT_SCHEME,
        network: requirements.network,
        payload: { unit },
      } as unknown as PaymentPayloadResult;
    }
    return { x402Version, payload: { unit } };
  }

  /** The requirements, if this client may pay them (network, limits, offer still valid). */
  private acceptable(
    x402Version: number,
    requirements: PaymentRequirements,
    context: PaymentPayloadContext | undefined,
  ): ParsedExactRequirements {
    if (x402Version !== 1 && x402Version !== 2) {
      throw new ObbyxError('invalid_x402_version', 'Only x402 v1 and v2 are supported');
    }
    // v1 requirements (maxAmountRequired, plain network name) → v2 shape.
    const v2 =
      x402Version === 1
        ? requirementsV1ToV2(requirements as unknown as PaymentRequirementsV1)
        : requirements;
    const parsed = parseExactRequirements(v2);
    if (!parsed.ok) throw new ObbyxError(parsed.reason, parsed.message);
    const req = parsed.value;
    if (req.network.caip2 !== this.options.network) {
      throw new ObbyxError('invalid_network', `This client pays on ${this.options.network}`);
    }
    const cap = this.options.maxAmount?.get(req.asset);
    if (cap !== undefined && req.amount > cap) {
      throw new ObbyxError(
        'amount_over_limit',
        `Price ${req.amount} exceeds the limit ${cap} for ${req.asset}`,
      );
    }
    if (
      context?.maxAmountPerPayment !== undefined &&
      req.amount > BigInt(context.maxAmountPerPayment)
    ) {
      throw new ObbyxError('amount_over_limit', 'Price exceeds maxAmountPerPayment');
    }
    if (req.extra.validUntil < Math.floor(Date.now() / 1000)) {
      throw new ObbyxError('quote_expired', 'The payment offer has expired');
    }
    return req;
  }

  /**
   * Composes and signs (never broadcasts) the unit: one output to payTo and the
   * binding in a data message. Refuses it when the network fee is above the limit.
   */
  private async signUnit(req: ParsedExactRequirements): Promise<Record<string, unknown>> {
    const output = { address: req.payTo, amount: toSafeNumber(req.amount) };
    const payment =
      req.asset === 'base'
        ? { app: 'payment', payload: { outputs: [output] } }
        : { app: 'payment', payload: { asset: req.asset, outputs: [output] } };
    const data = {
      app: 'data',
      payload: { x402: { binding: req.extra.binding, quoteId: req.extra.quoteId } },
    };
    const compose = () =>
      this.options.client.compose.message('multi', [payment, data] as never, {
        privateKey: this.options.privateKey,
        testnet: req.network.testnet,
      }) as unknown as Promise<Record<string, unknown>>;
    // The signed unit stays publishable until the offer expires plus the
    // facilitator's publication window: keep its inputs reserved that long.
    const holdUntil = req.extra.validUntil + PUBLICATION_MARGIN_SECONDS;
    const unit = await (this.options.composer
      ? this.options.composer.compose(compose, { holdUntil })
      : compose());
    const fee =
      BigInt(Number(unit['headers_commission'] ?? 0)) +
      BigInt(Number(unit['payload_commission'] ?? 0)) +
      BigInt(Number(unit['tps_fee'] ?? 0)) +
      BigInt(Number(unit['burn_fee'] ?? 0)); // same total the facilitator checks
    if (this.options.maxFee !== undefined && fee > this.options.maxFee) {
      // The unit was never sent anywhere: its inputs can be released at once.
      this.options.composer?.discard(String(unit['unit']));
      throw new ObbyxError(
        'fee_over_limit',
        `Network fee ${fee} exceeds the limit ${this.options.maxFee} bytes`,
      );
    }
    return unit;
  }
}
