import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactObyteScheme as ExactObyteClient } from "../../src/exact/client/scheme";
import { NETWORK, UNIT_TS, addressOf, offlineSigner, testKey } from "./units";

export const PAYER_KEY = testKey("payer");
export const PAYER = addressOf(PAYER_KEY);
export const SELLER = addressOf(testKey("seller"));
/** "Now" of the tests: shortly after the composed units. */
export const NOW = UNIT_TS + 10;

/**
 * `exact` requirements as a resource server would issue them.
 *
 * @param extra - Overrides of `extra`.
 * @returns The requirements.
 */
export function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: "base",
    amount: "20000",
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: { binding: "f0".repeat(32), quoteId: "quote-0001", validUntil: NOW + 600, ...extra },
  };
}

/**
 * Signs a payment for the requirements with the offline test wallet.
 *
 * @param req - Requirements.
 * @param opts - Signer options.
 * @param opts.includeDefinition - Embed the author definition.
 * @returns The payment payload.
 */
export async function pay(
  req: PaymentRequirements = requirements(),
  opts: { includeDefinition?: boolean } = {},
): Promise<PaymentPayload> {
  const client = new ExactObyteClient(offlineSigner(PAYER_KEY, opts), { now: () => NOW });
  const result = await client.createPaymentPayload(2, req);
  return { x402Version: 2, accepted: req, payload: result.payload };
}

/**
 * The unit of a payload.
 *
 * @param payload - Payment payload.
 * @returns The unit.
 */
export function unitOf(payload: PaymentPayload): Record<string, unknown> {
  return payload.payload["unit"] as Record<string, unknown>;
}
