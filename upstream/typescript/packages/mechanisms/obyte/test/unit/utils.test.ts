import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  constantTimeEqual,
  displayToAtomic,
  hubCall,
  isAddress,
  isAssetId,
  isObyteNetwork,
  parseAtomicAmount,
  randomId,
} from "../../src/utils";

describe("amounts", () => {
  it("parses canonical atomic amounts only", () => {
    expect(parseAtomicAmount("0")).toBe(0n);
    expect(parseAtomicAmount("20000")).toBe(20000n);
    for (const bad of ["", "01", "-1", "1.5", "1e3", " 1", String(2 ** 53), 5]) {
      expect(parseAtomicAmount(bad)).toBeUndefined();
    }
  });

  it("converts display amounts without floating point", () => {
    expect(displayToAtomic("0.00002", 9)).toBe(20000n);
    expect(displayToAtomic("1", 9)).toBe(1_000_000_000n);
    expect(displayToAtomic("0.0000000001", 9)).toBeUndefined();
    expect(displayToAtomic("abc", 9)).toBeUndefined();
  });
});

describe("identifiers", () => {
  it("knows the Obyte networks", () => {
    expect(isObyteNetwork("obyte:livenet")).toBe(true);
    expect(isObyteNetwork("obyte:testnet")).toBe(true);
    expect(isObyteNetwork("obyte-testnet")).toBe(false);
    expect(isObyteNetwork("eip155:8453")).toBe(false);
  });

  it("validates addresses by checksum and assets by shape", () => {
    expect(isAddress("AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM6")).toBe(true);
    expect(isAddress("AIC2WZ63HSBT3HUAC7VPI2GNM4WXDUM7")).toBe(false);
    expect(isAssetId("base")).toBe(true);
    expect(isAssetId("A".repeat(43) + "=")).toBe(true);
    expect(isAssetId("bytes")).toBe(false);
  });
});

describe("helpers", () => {
  it("canonical JSON sorts keys recursively and keeps arrays", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });

  it("compares in constant time", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("random ids are URL-safe and distinct", () => {
    const a = randomId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomId()).not.toBe(a);
  });
});

describe("hubCall", () => {
  it("classifies ok, hub errors and unknown outcomes", async () => {
    expect(await hubCall(async () => 1, 50)).toEqual({ kind: "ok", value: 1 });
    expect(await hubCall(() => Promise.reject("bad unit"), 50)).toEqual({
      kind: "hub_error",
      error: "bad unit",
    });
    expect(await hubCall(() => Promise.reject(new Error("socket closed")), 50)).toMatchObject({
      kind: "unknown",
    });
    expect(await hubCall(() => new Promise(() => undefined), 10)).toMatchObject({
      kind: "unknown",
      error: expect.stringContaining("timed out"),
    });
  });
});
