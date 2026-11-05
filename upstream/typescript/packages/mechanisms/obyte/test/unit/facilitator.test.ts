import type { PaymentPayload } from "@x402/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import * as C from "../../src/constants";
import {
  ExactObyteScheme,
  type ExactObyteFacilitatorConfig,
} from "../../src/exact/facilitator/scheme";
import { HISTORY_PROBE_ADDRESS, isTransientPostError } from "../../src/ledger";
import { InMemoryObyteSettlementStore } from "../../src/settlementStore";
import { FakeHub } from "../helpers/fakeHub";
import { NOW, PAYER, PAYER_KEY, SELLER, pay, requirements, unitOf } from "../helpers/fixtures";
import { HASH_A, NETWORK, fundPayer, sigDefinitionOf } from "../helpers/units";

let hub: FakeHub;
let store: InMemoryObyteSettlementStore;
let now: number;
let payload: PaymentPayload;

/**
 * A facilitator over the fake hub.
 *
 * @param config - Overrides.
 * @returns The facilitator scheme.
 */
function facilitator(config: Partial<ExactObyteFacilitatorConfig> = {}) {
  return new ExactObyteScheme({
    hubs: { [NETWORK]: hub },
    store,
    hubTimeoutMs: 20,
    historyProbeAddress: HISTORY_PROBE_ADDRESS,
    now: () => now,
    ...config,
  });
}

beforeEach(async () => {
  now = NOW;
  hub = new FakeHub();
  fundPayer(hub, PAYER);
  hub.definitions.set(SELLER, sigDefinitionOf(new Uint8Array(32).fill(3)));
  store = new InMemoryObyteSettlementStore(() => now);
  payload = await pay();
});

const unitHash = () => unitOf(payload)["unit"] as string;

describe("verify", () => {
  it("accepts a valid payment and reports the payer", async () => {
    expect(await facilitator().verify(payload, requirements())).toEqual({
      isValid: true,
      payer: PAYER,
    });
  });

  it("reads the definition from the ledger when it is not embedded", async () => {
    const bare = await pay(undefined, { includeDefinition: false });
    expect((await facilitator().verify(bare, requirements())).invalidReason).toBe(C.ERR_DEFINITION);
    hub.definitions.set(PAYER, sigDefinitionOf(PAYER_KEY));
    expect((await facilitator().verify(bare, requirements())).isValid).toBe(true);
  });

  it.each([
    [
      "accepted requirements differ",
      () => ({ ...payload, accepted: requirements({ quoteId: "quote-0002" }) }),
      C.ERR_INVALID_REQUIREMENTS,
    ],
    ["x402 v1", () => ({ ...payload, x402Version: 1 }), C.ERR_INVALID_VERSION],
  ])("rejects when %s", async (_n, make, reason) => {
    expect(
      (await facilitator().verify(make() as PaymentPayload, requirements())).invalidReason,
    ).toBe(reason);
  });

  it("rejects an expired offer, an asset it does not accept and an unserved network", async () => {
    now = NOW + 601;
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
      C.ERR_QUOTE_EXPIRED,
    );
    now = NOW;
    expect(
      (await facilitator({ assets: { [NETWORK]: [HASH_A] } }).verify(payload, requirements()))
        .invalidReason,
    ).toBe(C.ERR_ASSET);
    expect((await facilitator({ hubs: {} }).verify(payload, requirements())).invalidReason).toBe(
      C.ERR_INVALID_NETWORK,
    );
  });

  it("rejects payTo that is an autonomous agent", async () => {
    hub.definitions.set(SELLER, ["autonomous agent", { bounce_fees: { base: 10000 } }]);
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
      C.ERR_PAYTO_IS_AA,
    );
  });

  it("rejects a stale unit and an old last ball", async () => {
    const longOffer = requirements({ validUntil: NOW + 100_000 });
    const old = await pay(longOffer);
    now = NOW + 10_000;
    expect((await facilitator().verify(old, longOffer)).invalidReason).toBe(C.ERR_STALE);
    now = NOW;
    hub.joints.set("C".repeat(43) + "=", { unit: "C".repeat(43) + "=", timestamp: NOW - 20_000 });
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(C.ERR_STALE);
  });

  it("rejects inputs that are missing, foreign or already spent", async () => {
    hub.joints.delete(HASH_A);
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(C.ERR_INPUTS);
    fundPayer(hub, SELLER);
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(C.ERR_INPUTS);
    fundPayer(hub, PAYER);
    hub.history.push({
      unit: "D".repeat(43) + "=",
      messages: [
        {
          app: "payment",
          payload: { inputs: [{ unit: HASH_A, message_index: 0, output_index: 1 }] },
        },
      ],
    });
    expect((await facilitator().verify(payload, requirements())).invalidMessage).toMatch(
      /already spent/,
    );
  });

  it("answers ledger_unavailable when the hub does not answer", async () => {
    hub.down = true;
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
      C.ERR_LEDGER_UNAVAILABLE,
    );
  });
});

describe("settle", () => {
  it("publishes, waits for stability, then succeeds (idempotently)", async () => {
    const f = facilitator();
    const first = await f.settle(payload, requirements());
    expect(first).toMatchObject({
      success: false,
      errorReason: C.ERR_SETTLEMENT_PENDING,
      transaction: unitHash(),
    });
    expect(hub.joints.has(unitHash())).toBe(true);
    hub.stable.set(unitHash(), false);
    expect(await f.settle(payload, requirements())).toEqual({
      success: true,
      payer: PAYER,
      network: NETWORK,
      transaction: unitHash(),
      amount: "20000",
    });
    expect(await f.settle(payload, requirements())).toMatchObject({ success: true });
    expect(hub.calls["postJoint"]).toBe(1);
  });

  it("with finality=accepted succeeds once the hub accepted the unit", async () => {
    expect(
      await facilitator({ finality: "accepted" }).settle(payload, requirements()),
    ).toMatchObject({ success: true });
  });

  it("reports a final-bad unit as a double spend", async () => {
    const f = facilitator();
    await f.settle(payload, requirements());
    hub.stable.set(unitHash(), true);
    expect(await f.settle(payload, requirements())).toMatchObject({
      success: false,
      errorReason: C.ERR_DOUBLE_SPEND,
    });
  });

  it("refuses the same unit for another operation", async () => {
    const f = facilitator();
    await f.settle(payload, requirements());
    const other = requirements({ binding: "0e".repeat(32) });
    expect(await f.settle({ ...payload, accepted: other }, other)).toMatchObject({
      errorReason: C.ERR_PAYMENT_REUSED,
    });
  });

  it("a hub that does not answer before the claim is pending, and nothing is claimed", async () => {
    hub.down = true;
    expect(await facilitator().settle(payload, requirements())).toMatchObject({
      success: false,
      errorReason: C.ERR_SETTLEMENT_PENDING,
      transaction: unitHash(),
    });
    expect(await store.listActive()).toEqual([]);
  });

  it("a lost post answer is resolved by get_joint, never posted twice", async () => {
    hub.post = "drop";
    const f = facilitator({ finality: "accepted" });
    expect(await f.settle(payload, requirements())).toMatchObject({
      errorReason: C.ERR_SETTLEMENT_PENDING,
    });
    expect(await f.settle(payload, requirements())).toMatchObject({ success: true });
    expect(hub.calls["postJoint"]).toBe(1);
  });

  it("a transient hub answer is retried, a definite one is a rejection", async () => {
    hub.post = "transient";
    const f = facilitator();
    expect(await f.settle(payload, requirements())).toMatchObject({
      errorReason: C.ERR_SETTLEMENT_PENDING,
    });
    hub.post = "reject";
    expect(await f.settle(payload, requirements())).toMatchObject({
      success: false,
      errorReason: C.ERR_REJECTED_BY_NETWORK,
      errorMessage: hub.rejectError,
    });
  });

  it("a unit never posted expires after the publication window", async () => {
    const f = facilitator({ finality: "accepted" });
    hub.down = true;
    await store.claim({
      key: `${NETWORK}:unit:${unitHash()}`,
      network: NETWORK,
      unitHash: unitHash(),
      binding: "f0".repeat(32),
      payer: PAYER,
      payTo: SELLER,
      asset: "base",
      amount: "20000",
      unitJson: JSON.stringify(unitOf(payload)),
      publishDeadline: NOW + 300,
    });
    hub.down = false;
    now = NOW + 301;
    expect(await f.settle(payload, requirements({}))).toMatchObject({
      success: false,
      errorReason: C.ERR_PUBLICATION_WINDOW_EXPIRED,
    });
    expect(hub.calls["postJoint"]).toBeUndefined();
  });

  it("a unit posted with an unknown outcome is looked for during the grace period", async () => {
    hub.post = "hang";
    const f = facilitator();
    await f.settle(payload, requirements());
    hub.post = "accept";
    hub.joints.delete(unitHash()); // the post never landed
    now = NOW + 300 + C.POSTED_UNIT_GRACE_SECONDS;
    expect(await f.recoverPending()).toEqual([
      expect.objectContaining({ errorReason: C.ERR_SETTLEMENT_PENDING }),
    ]);
    expect(hub.calls["postJoint"]).toBe(1);
    now += 1;
    expect(await f.recoverPending()).toEqual([
      expect.objectContaining({ errorReason: C.ERR_PUBLICATION_WINDOW_EXPIRED }),
    ]);
  });

  it("concurrent settles of one unit share one pass", async () => {
    const f = facilitator({ finality: "accepted" });
    const [a, b] = await Promise.all([
      f.settle(payload, requirements()),
      f.settle(payload, requirements()),
    ]);
    expect(a).toEqual(b);
    expect(hub.calls["postJoint"]).toBe(1);
  });
});

describe("misc", () => {
  it("declares /supported extra and signs nothing", () => {
    const f = facilitator();
    expect(f.getExtra(NETWORK)).toEqual({ finality: "stable", assets: ["base"] });
    expect(f.getExtra("obyte:livenet")).toBeUndefined();
    expect(f.getSigners(NETWORK)).toEqual([]);
    expect(f.supportedNetworks()).toEqual([NETWORK]);
  });

  it("classifies post_joint answers", () => {
    expect(isTransientPostError("known unverified")).toBe(true);
    expect(isTransientPostError("Unknown parents")).toBe(true);
    expect(isTransientPostError("some inputs are already spent")).toBe(false);
  });
});
