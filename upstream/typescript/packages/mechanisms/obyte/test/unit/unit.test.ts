import { beforeAll, describe, expect, it } from "vitest";
import * as C from "../../src/constants";
import { compareOutputs, isSigDefinition, validateExactUnit } from "../../src/unit";
import { PAYER, PAYER_KEY, SELLER, pay, unitOf } from "../helpers/fixtures";
import { HASH_A, NETWORK, refinalize, sigDefinitionOf } from "../helpers/units";

const expectation = {
  network: NETWORK,
  payTo: SELLER,
  asset: "base",
  amount: 20000n,
  binding: "f0".repeat(32),
  quoteId: "quote-0001",
} as const;

let unit: Record<string, unknown>;
beforeAll(async () => {
  unit = unitOf(await pay());
});

type Messages = { app: string; payload: Record<string, unknown> }[];
const messages = (u: Record<string, unknown>) => u["messages"] as Messages;
const payment = (u: Record<string, unknown>) =>
  messages(u).find(m => m.app === "payment")!.payload as {
    outputs: { address: string; amount: number }[];
    inputs: unknown[];
  };

describe("validateExactUnit", () => {
  it("accepts a unit composed by the client and reports its facts", () => {
    const res = validateExactUnit(unit, expectation);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      unitHash: unit["unit"],
      payer: PAYER,
      inputs: [{ asset: "base", unit: HASH_A, messageIndex: 0, outputIndex: 1 }],
      definitionFromLedger: false,
    });
    expect(res.value.outputTotals["base"]).toBeGreaterThan(20000n);
  });

  it("requires the definition from the ledger when it is not embedded", async () => {
    const bare = unitOf(await pay(undefined, { includeDefinition: false }));
    expect(validateExactUnit(bare, expectation)).toMatchObject({
      reason: C.ERR_DEFINITION_REQUIRED,
    });
    const res = validateExactUnit(bare, expectation, {
      authorDefinition: sigDefinitionOf(PAYER_KEY),
    });
    expect(res).toMatchObject({ ok: true, value: { definitionFromLedger: true } });
  });

  const cases: [string, (u: Record<string, unknown>) => Record<string, unknown>, string][] = [
    [
      "a changed field without a new hash",
      u => ({ ...u, timestamp: (u["timestamp"] as number) + 1 }),
      C.ERR_UNIT_HASH,
    ],
    ["an unknown top-level field", u => ({ ...u, extra: 1 }), C.ERR_UNSUPPORTED_UNIT],
    ["the other network's version", u => ({ ...u, version: "4.0", alt: "1" }), C.ERR_NETWORK],
    [
      "a payload that does not match its hash",
      u => {
        const v = structuredClone(u);
        payment(v).outputs.find(o => o.address === SELLER)!.amount = 30000;
        return refinalize(v, PAYER_KEY, { payloadHashes: false });
      },
      C.ERR_PAYLOAD_HASH,
    ],
    [
      "a wrong amount (re-signed by the payer)",
      u => {
        const v = structuredClone(u);
        const outs = payment(v).outputs;
        outs.find(o => o.address === SELLER)!.amount = 19999;
        outs.find(o => o.address === PAYER)!.amount += 1;
        return refinalize(v, PAYER_KEY);
      },
      C.ERR_AMOUNT,
    ],
    [
      "an output to a third address",
      u => {
        const v = structuredClone(u);
        payment(v).outputs.find(o => o.address === PAYER)!.address =
          "AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6";
        payment(v).outputs.sort(compareOutputs);
        return refinalize(v, PAYER_KEY);
      },
      C.ERR_RECIPIENT,
    ],
    [
      "another binding",
      u => {
        const v = structuredClone(u);
        messages(v).find(m => m.app === "data")!.payload = {
          x402: { binding: "0".repeat(64), quoteId: "quote-0001" },
        };
        return refinalize(v, PAYER_KEY);
      },
      C.ERR_BINDING,
    ],
    [
      "commissions that do not match the size",
      u =>
        refinalize(
          { ...u, headers_commission: (u["headers_commission"] as number) - 1 },
          PAYER_KEY,
          { commissions: false },
        ),
      C.ERR_COMMISSIONS,
    ],
    [
      "a signature by another key",
      u => {
        const v = refinalize(u, new Uint8Array(32).fill(7), { unitHash: true });
        return v;
      },
      C.ERR_SIGNATURE,
    ],
    [
      "a unit above the size limit",
      u => ({ ...u, messages: [...messages(u), { app: "data", payload: "x".repeat(20_000) }] }),
      C.ERR_UNIT_TOO_LARGE,
    ],
  ];

  it.each(cases)("rejects %s", (_name, mutate, reason) => {
    expect(validateExactUnit(mutate(unit), expectation)).toMatchObject({ ok: false, reason });
  });

  it("rejects payTo as the payer and facilitator addresses as the payer", () => {
    expect(validateExactUnit(unit, { ...expectation, payTo: PAYER })).toMatchObject({
      reason: C.ERR_PAYER,
    });
    expect(
      validateExactUnit(unit, { ...expectation, facilitatorAddresses: [PAYER] }),
    ).toMatchObject({
      reason: C.ERR_PAYER,
    });
  });

  it("rejects a payment in another asset than required", () => {
    expect(validateExactUnit(unit, { ...expectation, asset: HASH_A })).toMatchObject({
      reason: C.ERR_ASSET,
    });
  });

  it("knows the supported definition profile", () => {
    expect(isSigDefinition(sigDefinitionOf(PAYER_KEY))).toBe(true);
    expect(isSigDefinition(["sig", { pubkey: "short" }])).toBe(false);
    expect(isSigDefinition(["or", []])).toBe(false);
  });
});
