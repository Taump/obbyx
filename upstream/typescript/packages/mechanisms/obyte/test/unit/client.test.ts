import { describe, expect, it } from "vitest";
import * as C from "../../src/constants";
import { ExactObyteScheme, ObytePaymentRefusedError } from "../../src/exact/client/scheme";
import { NOW, PAYER, PAYER_KEY, SELLER, requirements } from "../helpers/fixtures";
import { offlineSigner } from "../helpers/units";

const client = (config = {}) =>
  new ExactObyteScheme(offlineSigner(PAYER_KEY), { now: () => NOW, ...config });

describe("ExactObyteScheme (client)", () => {
  it("signs one payment to payTo with the binding in a data message", async () => {
    const { payload } = await client().createPaymentPayload(2, requirements());
    const unit = payload["unit"] as {
      messages: { app: string; payload: Record<string, unknown> }[];
    };
    const data = unit.messages.find(m => m.app === "data")!.payload;
    expect(data).toEqual({ x402: { binding: "f0".repeat(32), quoteId: "quote-0001" } });
    const outputs = unit.messages.find(m => m.app === "payment")!.payload["outputs"] as {
      address: string;
      amount: number;
    }[];
    expect(outputs).toContainEqual({ address: SELLER, amount: 20000 });
    expect(outputs.every(o => o.address === SELLER || o.address === PAYER)).toBe(true);
  });

  it.each([
    ["x402 v1", () => client().createPaymentPayload(1, requirements()), C.ERR_INVALID_VERSION],
    [
      "an expired offer",
      () => client().createPaymentPayload(2, requirements({ validUntil: NOW - 1 })),
      C.ERR_QUOTE_EXPIRED,
    ],
    [
      "a price above the limit",
      () => client({ maxAmount: { base: 19999n } }).createPaymentPayload(2, requirements()),
      C.ERR_AMOUNT_OVER_LIMIT,
    ],
    [
      "a price above maxAmountPerPayment",
      () =>
        client().createPaymentPayload(2, requirements(), { maxAmountPerPayment: "100" } as never),
      C.ERR_AMOUNT_OVER_LIMIT,
    ],
    [
      "a fee above the limit",
      () => client({ maxFee: 10n }).createPaymentPayload(2, requirements()),
      C.ERR_FEE_OVER_LIMIT,
    ],
    [
      "malformed requirements",
      () => client().createPaymentPayload(2, { ...requirements(), payTo: "nope" }),
      C.ERR_INVALID_REQUIREMENTS,
    ],
    [
      "unknown extra fields",
      () => client().createPaymentPayload(2, requirements({ splits: [] })),
      C.ERR_INVALID_REQUIREMENTS,
    ],
    [
      "paying itself",
      () => client().createPaymentPayload(2, { ...requirements(), payTo: PAYER }),
      C.ERR_PAYER,
    ],
  ])("refuses %s", async (_n, run, reason) => {
    await expect(run()).rejects.toMatchObject({ reason });
    await expect(run()).rejects.toBeInstanceOf(ObytePaymentRefusedError);
  });
});
