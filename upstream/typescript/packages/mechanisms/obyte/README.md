# `@x402/obyte`

Obyte implementation of the x402 payment protocol using the **Exact** payment scheme: the client signs an Obyte unit that pays `payTo`, the facilitator verifies and publishes it.

## Installation

```bash
npm install @x402/obyte
```

## Overview

Three components, one per role:

- **Client** (`@x402/obyte/exact/client`): composes and signs a unit paying `payTo`, with the seller's offer binding in a `data` message. It does not broadcast. The payer pays the network fees.
- **Facilitator** (`@x402/obyte/exact/facilitator`): `verify` checks the unit read-only (local profile, then ledger reads through a hub). `settle` claims it, publishes it and reports success when the finality policy is met. The facilitator holds no keys and signs nothing.
- **Server** (`@x402/obyte/exact/server`): adds a per-request HMAC binding and quote to every offer and keeps a registry so that one payment serves one request.

**Key differences from EVM/SVM:**

- **Payer-signed, facilitator-published.** The unit hash is the payment's identity and is known before broadcast, so `settlement_pending` always carries a non-empty `transaction`.
- **Finality.** With `finality: "stable"` (default) `settle` succeeds only once the unit is stable and good. Stability can take minutes, and up to about 2 hours on a quiet network. Until then `settle` answers `settlement_pending` and a retry with the same payment resumes it.
- **Binding instead of a nonce.** An Obyte unit never expires. A payment is tied to one request by an HMAC the resource server computes over the offer and the request; the client signs it into the unit.
- **Upfront flow only** on the server. The payment is claimed and settled before the handler runs.
- **No default USD asset.** Prices are in bytes (`"20000 bytes"`, `"0.00002 GBYTE"`) or `{ asset, amount }` in atomic units. Clients with default spend controls must opt in to the asset (see below).

## Networks

| Network | CAIP-2 | Default hub |
| ------- | ------ | ----------- |
| Livenet | `obyte:livenet` | `wss://obyte.org/bb` |
| Testnet | `obyte:testnet` | `wss://obyte.org/bb-test` |

The `obyte` namespace is not registered in ChainAgnostic yet; the identifiers are proposed by the scheme specification (`specs/schemes/exact/scheme_exact_obyte.md`).

## Usage

### Client

```typescript
import { x402Client } from "@x402/core/client";
import { ExactObyteScheme } from "@x402/obyte/exact/client";
import { connectObyteHub, parseObytePrivateKey, toClientObyteSigner } from "@x402/obyte";

const signer = toClientObyteSigner(
  connectObyteHub("wss://obyte.org/bb-test", "obyte:testnet"),
  parseObytePrivateKey(process.env.OBYTE_PRIVATE_KEY!),
);
const client = x402Client.fromConfig({
  schemes: [{ network: "obyte:*", client: new ExactObyteScheme(signer, { maxFee: 5000n }) }],
  // Obyte has no default USD asset: allow bytes explicitly, with an atomic cap.
  spendControls: {
    allowedAssets: [{ network: "obyte:testnet", asset: "base", maxAmountPerPayment: "1000000" }],
  },
});
```

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactObyteScheme } from "@x402/obyte/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register(
  "obyte:*",
  new ExactObyteScheme({ sellerId: "my-api", secret: process.env.BINDING_SECRET! }),
);
// Route price: "20000 bytes", "0.00002 GBYTE" or { asset: "base", amount: "20000" }.
```

The binding covers the method, the path and query, and the canonical JSON body, so the framework adapter must expose the parsed body (`getBody`). Keep `secret` (at least 32 bytes) stable and private. With more than one process, pass a shared `proofs` store (`ObyteProofStore`).

### Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactObyteScheme } from "@x402/obyte/exact/facilitator";
import { connectObyteHub, toObyteHub } from "@x402/obyte";

const scheme = new ExactObyteScheme({
  hubs: { "obyte:testnet": toObyteHub(connectObyteHub("wss://obyte.org/bb-test", "obyte:testnet")) },
  finality: "stable",
});
const facilitator = new x402Facilitator().register("obyte:testnet", scheme);
// Re-drive settlements that are not final yet (and after a restart with a durable store):
setInterval(() => void scheme.recoverPending(), 30_000);
```

The default settlement store is process-local. A production facilitator should pass a durable `store` (`ObyteSettlementStore`) whose `claim` and `transition` are atomic, and run `recoverPending()` periodically.

## Trust model

The facilitator trusts its hub for ledger reads: input existence and ownership, spent status, last ball and stability. Signatures, hashes, the unit profile, commissions and the binding are checked locally. `payTo` must not be an autonomous agent (an AA could bounce the payment back).

## Error codes

Reason codes follow `invalid_exact_obyte_<reason>` (see `src/constants.ts`); `settlement_pending` means "not final yet, retry with the same payment".
