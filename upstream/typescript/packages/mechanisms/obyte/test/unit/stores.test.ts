import { describe, expect, it } from "vitest";
import { InMemoryObyteProofStore } from "../../src/proofStore";
import { InMemoryObyteSettlementStore } from "../../src/settlementStore";

const settlement = {
  key: "obyte:testnet:unit:U",
  network: "obyte:testnet",
  unitHash: "U",
  binding: "b",
  payer: "P",
  payTo: "S",
  asset: "base",
  amount: "1",
  unitJson: "{}",
  publishDeadline: 100,
};

describe("InMemoryObyteSettlementStore", () => {
  it("claims once and moves only by compare-and-set", async () => {
    let now = 10;
    const store = new InMemoryObyteSettlementStore(() => now);
    expect((await store.claim(settlement)).created).toBe(true);
    const again = await store.claim({ ...settlement, binding: "other" });
    expect(again).toMatchObject({ created: false, record: { binding: "b", state: "claimed" } });
    now = 11;
    expect(
      await store.transition(settlement.key, ["claimed"], "broadcasting", {
        incrementAttempts: true,
      }),
    ).toMatchObject({ state: "broadcasting", attempts: 1, updatedAt: 11 });
    expect(await store.transition(settlement.key, ["claimed"], "accepted")).toBeUndefined();
    expect(await store.transition("missing", ["claimed"], "accepted")).toBeUndefined();
  });

  it("lists active records, least recently touched first", async () => {
    let now = 1;
    const store = new InMemoryObyteSettlementStore(() => now);
    await store.claim(settlement);
    now = 2;
    await store.claim({ ...settlement, key: "k2" });
    now = 3;
    await store.touch(settlement.key);
    expect((await store.listActive()).map(r => r.key)).toEqual(["k2", settlement.key]);
    await store.transition("k2", ["claimed"], "expired");
    expect((await store.listActive()).map(r => r.key)).toEqual([settlement.key]);
  });
});

describe("InMemoryObyteProofStore", () => {
  it("registers once, keeps the first binding, and reclaims stale claims", async () => {
    let now = 0;
    const proofs = new InMemoryObyteProofStore(() => now);
    expect(await proofs.begin("k", "b1")).toMatchObject({ state: "settling", binding: "b1" });
    expect(await proofs.begin("k", "b2")).toMatchObject({ binding: "b1" });
    expect(await proofs.transition("k", "settling", "serving")).toBe(true);
    expect(await proofs.transition("k", "settling", "serving")).toBe(false);
    now = 100;
    await proofs.reclaimStale("k", 300);
    expect((await proofs.get("k"))?.state).toBe("serving");
    now = 400;
    await proofs.reclaimStale("k", 300);
    expect((await proofs.get("k"))?.state).toBe("settling");
  });
});
