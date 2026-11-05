import { describe, expect, it } from "vitest";
import { bindingsEqual, bodyHashOf, computeBinding, newQuoteId } from "../../src/binding";

describe("binding", () => {
  const input = {
    sellerId: "api",
    scheme: "exact",
    quoteId: "quote-0001",
    validUntil: 1_790_000_310,
    method: "GET",
    url: "/api/x",
    bodyHash: bodyHashOf(undefined),
    network: "obyte:testnet",
    asset: "base",
    amount: "20000",
    payTo: "AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6",
  };

  it("matches the test vector of the scheme specification", () => {
    expect(computeBinding("s".repeat(32), input)).toBe(
      "d0a417add6f72db9139e06a23107f8d7494d7b6f92d81edd0d949ec30a7ad698",
    );
  });

  it("changes with every field and normalizes the method", () => {
    const base = computeBinding("s".repeat(32), input);
    expect(computeBinding("s".repeat(32), { ...input, method: "get" })).toBe(base);
    for (const [k, v] of Object.entries({
      url: "/api/y",
      amount: "20001",
      payTo: "X",
      quoteId: "q2",
    })) {
      expect(computeBinding("s".repeat(32), { ...input, [k]: v })).not.toBe(base);
    }
    expect(computeBinding("t".repeat(32), input)).not.toBe(base);
  });

  it("hashes the canonical body", () => {
    expect(bodyHashOf(undefined)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(bodyHashOf({ b: 1, a: 2 })).toBe(bodyHashOf({ a: 2, b: 1 }));
  });

  it("compares bindings and issues quote ids", () => {
    expect(bindingsEqual("ab", "ab")).toBe(true);
    expect(bindingsEqual("ab", "ac")).toBe(false);
    expect(newQuoteId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
