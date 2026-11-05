import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import { ExactObyteScheme as ExactObyteClient } from "../../src/exact/client/scheme";
import { ExactObyteScheme as ExactObyteFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactObyteScheme as ExactObyteServer } from "../../src/exact/server/scheme";
import { FakeHub } from "../helpers/fakeHub";
import { NOW, PAYER, PAYER_KEY, SELLER } from "../helpers/fixtures";
import { NETWORK, fundPayer, offlineSigner, sigDefinitionOf } from "../helpers/units";

/**
 * Wraps the x402Facilitator for use with x402ResourceServer (in process).
 */
class InProcessFacilitatorClient implements FacilitatorClient {
  /**
   * @param facilitator - The facilitator to wrap.
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @returns Verification response.
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @returns Settlement response.
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  /**
   * @returns Supported kinds.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * A minimal HTTP adapter, as framework middleware provides.
 *
 * @param method - HTTP method.
 * @param url - Path and query.
 * @param headers - Request headers.
 * @param body - Parsed body.
 * @returns The adapter.
 */
function adapter(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): HTTPAdapter {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    getHeader: name => lower[name.toLowerCase()],
    getMethod: () => method,
    getPath: () => new URL(url, "http://localhost").pathname,
    getUrl: () => `http://localhost${url}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "test",
    getBody: () => body,
  };
}

let hub: FakeHub;
let http: x402HTTPResourceServer;
let now: number;

const ROUTES = {
  "POST /api/q": {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: SELLER,
      price: "20000 bytes",
      maxTimeoutSeconds: 300,
    },
    description: "paid query",
  },
} as const;

/**
 * One request through the resource server.
 *
 * @param body - Request body.
 * @param paymentHeader - PAYMENT-SIGNATURE header.
 * @param url - Path and query.
 * @returns The process result.
 */
async function request(
  body: unknown,
  paymentHeader?: string,
  url = "/api/q",
): Promise<HTTPProcessResult> {
  const headers: Record<string, string> =
    paymentHeader === undefined ? {} : { "PAYMENT-SIGNATURE": paymentHeader };
  return http.processHTTPRequest({
    adapter: adapter("POST", url, headers, body),
    path: new URL(url, "http://localhost").pathname,
    method: "POST",
    ...(paymentHeader === undefined ? {} : { paymentHeader }),
  });
}

const buyer = () =>
  x402Client.fromConfig({
    schemes: [
      {
        network: NETWORK,
        client: new ExactObyteClient(offlineSigner(PAYER_KEY), { now: () => now }),
      },
    ],
    spendControls: {
      allowedAssets: [{ network: NETWORK, asset: "base", maxAmountPerPayment: "100000" }],
    },
  });

/**
 * Gets an offer for `body` and signs a payment for it.
 *
 * @param body - Request body.
 * @returns The PAYMENT-SIGNATURE header.
 */
async function paidHeader(body: unknown): Promise<string> {
  const offer = await request(body);
  expect(offer.type).toBe("payment-error");
  if (offer.type !== "payment-error") throw new Error("expected 402");
  expect(offer.response.status).toBe(402);
  const required = decodePaymentRequiredHeader(offer.response.headers["PAYMENT-REQUIRED"]!);
  const payload = await buyer().createPaymentPayload(required);
  return encodePaymentSignatureHeader(payload);
}

describe("Obyte exact: x402Client / x402HTTPResourceServer / x402Facilitator", () => {
  beforeEach(async () => {
    now = NOW;
    hub = new FakeHub();
    fundPayer(hub, PAYER);
    hub.definitions.set(SELLER, sigDefinitionOf(new Uint8Array(32).fill(3)));
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new ExactObyteFacilitator({
        hubs: { [NETWORK]: hub },
        finality: "accepted",
        hubTimeoutMs: 20,
        now: () => now,
      }),
    );
    const server = new x402ResourceServer(new InProcessFacilitatorClient(facilitator));
    server.register(
      NETWORK,
      new ExactObyteServer({ sellerId: "api", secret: "s".repeat(32), now: () => now }),
    );
    http = new x402HTTPResourceServer(server, ROUTES as never);
    await http.initialize();
  });

  it("advertises the scheme and offers a per-request binding", async () => {
    const offer = await request({ q: "hello" });
    if (offer.type !== "payment-error") throw new Error("expected 402");
    const required = decodePaymentRequiredHeader(offer.response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: NETWORK,
        asset: "base",
        amount: "20000",
        payTo: SELLER,
        extra: expect.objectContaining({ binding: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      }),
    ]);
  });

  it("pays, settles before the handler (upfront) and serves once", async () => {
    const header = await paidHeader({ q: "hello" });
    const paid = await request({ q: "hello" }, header);
    expect(paid.type).toBe("payment-verified");
    if (paid.type !== "payment-verified") return;
    expect(paid.beforeHandlerSettlement?.result).toMatchObject({ success: true, payer: PAYER });
    expect(hub.calls["postJoint"]).toBe(1);

    // The same payment again: refused, never served twice.
    const again = await request({ q: "hello" }, header);
    expect(again.type).toBe("payment-error");
  });

  it("a payment for one request does not pay for another", async () => {
    const header = await paidHeader({ q: "hello" });
    const other = await request({ q: "something else" }, header);
    expect(other.type).toBe("payment-error");
    if (other.type !== "payment-error") return;
    expect(other.response.status).toBe(402);
    expect(hub.calls["postJoint"]).toBeUndefined();
  });

  it("a settlement that is not final yet answers 402 and the same payment succeeds later", async () => {
    const header = await paidHeader({ q: "hello" });
    hub.post = "hang";
    const pending = await request({ q: "hello" }, header);
    expect(pending.type).toBe("payment-error");
    if (pending.type === "payment-error") {
      const settle = pending.response.headers["PAYMENT-RESPONSE"];
      if (settle !== undefined) expect(decodePaymentResponseHeader(settle).success).toBe(false);
    }
    hub.post = "accept";
    const retried = await request({ q: "hello" }, header);
    expect(retried.type).toBe("payment-verified");
  });

  it("default spend controls refuse Obyte (no default USD asset): clients opt in", async () => {
    const offer = await request({ q: "hello" });
    if (offer.type !== "payment-error") throw new Error("expected 402");
    const required = decodePaymentRequiredHeader(offer.response.headers["PAYMENT-REQUIRED"]!);
    const guarded = x402Client.fromConfig({
      schemes: [
        {
          network: NETWORK,
          client: new ExactObyteClient(offlineSigner(PAYER_KEY), { now: () => now }),
        },
      ],
    });
    await expect(guarded.createPaymentPayload(required)).rejects.toThrow();
  });
});
