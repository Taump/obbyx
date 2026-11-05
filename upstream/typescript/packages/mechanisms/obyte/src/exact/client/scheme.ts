import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  BYTES_ASSET,
  ERR_AMOUNT_OVER_LIMIT,
  ERR_FEE_OVER_LIMIT,
  ERR_INVALID_VERSION,
  ERR_PAYER,
  ERR_QUOTE_EXPIRED,
  SCHEME_EXACT,
} from "../../constants";
import type { ClientObyteSigner } from "../../signer";
import { parseExactRequirements } from "../requirements";

/** Client configuration. */
export interface ExactObyteClientConfig {
  /** Refuse requirements above this amount (atomic units), per asset. */
  readonly maxAmount?: Readonly<Record<string, bigint>>;
  /** Refuse units whose network fees exceed this, in bytes. */
  readonly maxFee?: bigint;
  /** Clock in unix seconds. */
  readonly now?: () => number;
}

/** Error thrown when the client refuses to sign a payment. */
export class ObytePaymentRefusedError extends Error {
  readonly reason: string;

  /**
   * Creates the error.
   *
   * @param reason - Stable reason code.
   * @param message - Explanation.
   */
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ObytePaymentRefusedError";
    this.reason = reason;
  }
}

/**
 * Obyte client for the `exact` scheme: composes and signs (but does not
 * broadcast) a unit paying `payTo`, with the seller's binding in a data
 * message. The payer pays the network fees.
 */
export class ExactObyteScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_EXACT;
  private readonly signer: ClientObyteSigner;
  private readonly config: ExactObyteClientConfig;

  /**
   * Creates the client scheme.
   *
   * @param signer - Signs payment units.
   * @param config - Spending limits.
   */
  constructor(signer: ClientObyteSigner, config: ExactObyteClientConfig = {}) {
    this.signer = signer;
    this.config = config;
  }

  /**
   * Signs a payment unit for the requirements.
   *
   * @param x402Version - Protocol version (2).
   * @param requirements - The accepted requirements.
   * @param context - Optional spending limit from the x402 client.
   * @returns The payload `{unit}`.
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) {
      throw new ObytePaymentRefusedError(ERR_INVALID_VERSION, "Only x402 v2 is supported");
    }
    const parsed = parseExactRequirements(requirements);
    if (!parsed.ok) throw new ObytePaymentRefusedError(parsed.reason, parsed.message);
    const req = parsed.value;
    const cap = this.config.maxAmount?.[req.asset];
    if (cap !== undefined && req.amount > cap) {
      throw new ObytePaymentRefusedError(
        ERR_AMOUNT_OVER_LIMIT,
        `Price ${req.amount} exceeds the limit ${cap} for ${req.asset}`,
      );
    }
    if (
      context?.maxAmountPerPayment !== undefined &&
      req.amount > BigInt(context.maxAmountPerPayment)
    ) {
      throw new ObytePaymentRefusedError(
        ERR_AMOUNT_OVER_LIMIT,
        "Price exceeds maxAmountPerPayment",
      );
    }
    const now = this.config.now?.() ?? Math.floor(Date.now() / 1000);
    if (req.extra.validUntil < now) {
      throw new ObytePaymentRefusedError(ERR_QUOTE_EXPIRED, "The payment offer has expired");
    }
    if (req.payTo === this.signer.address) {
      throw new ObytePaymentRefusedError(ERR_PAYER, "payTo is the payer itself");
    }

    const output = { address: req.payTo, amount: Number(req.amount) };
    const payment =
      req.asset === BYTES_ASSET
        ? { app: "payment", payload: { outputs: [output] } }
        : { app: "payment", payload: { asset: req.asset, outputs: [output] } };
    const data = {
      app: "data",
      payload: { x402: { binding: req.extra.binding, quoteId: req.extra.quoteId } },
    };
    const unit = await this.signer.signUnit(req.network, [payment, data]);
    const fee =
      BigInt(Number(unit["headers_commission"] ?? 0)) +
      BigInt(Number(unit["payload_commission"] ?? 0)) +
      BigInt(Number(unit["tps_fee"] ?? 0)) +
      BigInt(Number(unit["burn_fee"] ?? 0));
    if (this.config.maxFee !== undefined && fee > this.config.maxFee) {
      throw new ObytePaymentRefusedError(
        ERR_FEE_OVER_LIMIT,
        `Network fee ${fee} exceeds the limit ${this.config.maxFee} bytes`,
      );
    }
    return { x402Version, payload: { unit } };
  }
}
