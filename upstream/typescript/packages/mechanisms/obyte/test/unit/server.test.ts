import type { PaymentRequirements } from "@x402/core/types";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { bodyHashOf, computeBinding } from "../../src/binding";
import * as C from "../../src/constants";
import { ExactObyteScheme } from "../../src/exact/server/scheme";
import { InMemoryObyteProofStore } from "../../src/proofStore";
import { NOW, SELLER } from "../helpers/fixtures";
import { HASH_A, NETWORK } from "../helpers/units";

const SECRET = "s".repeat(32);
const base: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: "base",
  amount: "20000",
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: {},
};

const server = (proofs = new InMemoryObyteProofStore(() => NOW)) =>
  new ExactObyteScheme({ sellerId: "api", secret: SECRET, proofs, now: () => NOW });

const context = (method: string, url: string, body?: unknown, paymentHeader?: string) =>
  ({
    requirements: [base],
    transportContext: {
      request: {
        adapter: { getMethod: () => method, getUrl: () => url, getBody: () => body },
        ...(paymentHeader === undefined ? {} : { paymentHeader }),
      },
    },
  }) as never;

describe("parsePrice", () => {
  it("accepts atomic asset amounts, bytes and GBYTE; refuses USD", async () => {
    const s = server();
    expect(await s.parsePrice({ asset: "base", amount: "20000" }, NETWORK)).toEqual({
      asset: "base",
      amount: "20000",
    });
    expect(await s.parsePrice({ asset: HASH_A, amount: "5" }, NETWORK)).toEqual({
      asset: HASH_A,
      amount: "5",
    });
    expect(await s.parsePrice("20000 bytes", NETWORK)).toEqual({ asset: "base", amount: "20000" });
    expect(await s.parsePrice("0.00002 GBYTE", NETWORK)).toEqual({
      asset: "base",
      amount: "20000",
    });
    await expect(s.parsePrice("$0.01", NETWORK)).rejects.toThrow(/Obyte price/);
    await expect(s.parsePrice({ asset: "usdc", amount: "1" }, NETWORK)).rejects.toThrow();
    await expect(s.parsePrice("1 bytes", "eip155:8453")).rejects.toThrow(/Unsupported/);
    expect(s.getAssetDecimals("base")).toBe(9);
    expect(s.getAssetDecimals(HASH_A)).toBeUndefined();
  });
});

describe("binding of offers", () => {
  it("issues a fresh binding per request, computed over the request", async () => {
    const [req] = await server().enrichPaymentRequiredResponse(
      context("post", "/api/q?x=1", { q: "hi" }),
    );
    const extra = req!.extra as { binding: string; quoteId: string; validUntil: number };
    expect(extra.validUntil).toBe(NOW + C.DEFAULT_QUOTE_TTL_SECONDS);
    expect(extra.binding).toBe(
      computeBinding(SECRET, {
        sellerId: "api",
        scheme: "exact",
        quoteId: extra.quoteId,
        validUntil: extra.validUntil,
        method: "POST",
        url: "/api/q?x=1",
        bodyHash: bodyHashOf({ q: "hi" }),
        network: NETWORK,
        asset: "base",
        amount: "20000",
        payTo: SELLER,
      }),
    );
  });

  it("re-confirms the accepted quote only for the same request", async () => {
    const [offer] = await server().enrichPaymentRequiredResponse(context("GET", "/a"));
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: offer!,
      payload: {},
    } as never);
    const [same] = await server().enrichPaymentRequiredResponse(
      context("GET", "/a", undefined, header),
    );
    expect(same!.extra).toEqual(offer!.extra);
    const [moved] = await server().enrichPaymentRequiredResponse(
      context("GET", "/b", undefined, header),
    );
    expect((moved!.extra as { binding: string }).binding).not.toBe(
      (offer!.extra as { binding: string }).binding,
    );
  });

  it("needs the HTTP request and a strong secret", async () => {
    await expect(
      server().enrichPaymentRequiredResponse({ requirements: [base] } as never),
    ).rejects.toThrow(/request/);
    expect(() => new ExactObyteScheme({ sellerId: "api", secret: "short" })).toThrow(/32 bytes/);
  });

  it("declares the upfront flow only", () => {
    expect(server().paymentFlows.default).toEqual({ supported: ["upfront"], default: "upfront" });
  });
});

describe("one payment, one request (hooks)", () => {
  const unit = "U".repeat(43) + "=";
  const ctx = (binding = "b".repeat(64)) =>
    ({
      paymentPayload: { payload: { unit: { unit } } },
      requirements: { ...base, extra: { binding } },
    }) as never;

  it("claims before settle, consumes on success, refuses a second use", async () => {
    const proofs = new InMemoryObyteProofStore(() => NOW);
    const h = server(proofs).schemeHooks;
    expect(await h.onBeforeVerify!(ctx())).toBeUndefined();
    expect(await h.onBeforeSettle!(ctx())).toBeUndefined();
    expect(await h.onBeforeSettle!(ctx())).toEqual({
      abort: true,
      reason: C.ERR_PAYMENT_IN_PROGRESS,
    });
    await h.onAfterSettle!({ ...(ctx() as object), result: { success: true } } as never);
    expect(await h.onBeforeVerify!(ctx())).toEqual({
      abort: true,
      reason: C.ERR_PAYMENT_ALREADY_USED,
    });
    expect(await h.onBeforeSettle!(ctx())).toEqual({
      abort: true,
      reason: C.ERR_PAYMENT_ALREADY_USED,
    });
  });

  it("a pending settle or a failed handler keeps the payment usable for the same operation", async () => {
    const proofs = new InMemoryObyteProofStore(() => NOW);
    const h = server(proofs).schemeHooks;
    await h.onBeforeVerify!(ctx());
    await h.onBeforeSettle!(ctx());
    await h.onAfterSettle!({ ...(ctx() as object), result: { success: false } } as never);
    expect(await h.onBeforeSettle!(ctx())).toBeUndefined();
    await h.onAfterSettle!({ ...(ctx() as object), result: { success: true } } as never);
    await h.onVerifiedPaymentCanceled!({
      ...(ctx() as object),
      settledPhases: ["before-handler"],
    } as never);
    expect(await h.onBeforeSettle!(ctx())).toBeUndefined();
  });

  it("refuses a known payment for another operation", async () => {
    const h = server().schemeHooks;
    await h.onBeforeVerify!(ctx());
    expect(await h.onBeforeVerify!(ctx("c".repeat(64)))).toEqual({
      abort: true,
      reason: C.ERR_PAYMENT_REUSED,
    });
  });
});
