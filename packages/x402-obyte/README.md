# @obbyx/x402-obyte

[x402](https://x402.org) payment mechanisms for the [Obyte](https://obyte.org)
network, for the official `@x402/*` packages and for obbyx.

- **`exact`** — the client signs one Obyte unit per request; the facilitator verifies and broadcasts it.
- **`batch-settlement`** — instant, fee-free per call over Obyte AA payment channels (cumulative vouchers).

Networks: `obyte:livenet`, `obyte:testnet` (v1: `obyte-livenet`, `obyte-testnet`).

```sh
npm i @obbyx/x402-obyte obyte @x402/fetch
```

## Pay with the official `@x402/fetch`

```ts
import obyte from 'obyte';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactObyteClient } from '@obbyx/x402-obyte';
import { createLogger } from '@obbyx/obyte/logger';
import { loadWallet } from '@obbyx/obyte/wallet';
import { OBYTE_NETWORKS } from '@obbyx/obyte';

const network = OBYTE_NETWORKS.testnet;
const wallet = loadWallet(network); // ~/.obbyx/wallet-testnet.json (create it with `obbyx init`)
const client = new obyte.Client(network.defaultHubUrl, { testnet: true, reconnect: true });

const paidFetch = wrapFetchWithPayment(
  fetch,
  new x402Client()
    // GBYTE is not a default USD asset: allow it explicitly, with a cap per payment
    .setSpendControls({
      allowedAssets: [{ network: 'obyte:testnet', asset: 'base', maxAmountPerPayment: '50000' }],
    })
    .register(
      'obyte:testnet',
      new ExactObyteClient({
        client,
        network: 'obyte:testnet',
        privateKey: wallet.privateKey,
        logger: createLogger(),
      }),
    ),
);
const res = await paidFetch('https://api.example/paid');
```

Add a `ReservingComposer` (`composer` option) when one wallet pays concurrently:
it guarantees two payments never pick the same coins.

## What is inside

| Export                                                                      | Role                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ExactObyteClient`, `BatchObyteClient`                                      | x402 client mechanisms (`SchemeNetworkClient`)           |
| `ExactObyteFacilitator`, `ExactObyteFacilitatorV1`, `BatchObyteFacilitator` | facilitator mechanisms (`SchemeNetworkFacilitator`)      |
| `SettlementStore`, `BatchStore`, `WatcherGateway`                           | storage / watcher ports (+ node:sqlite reference stores) |
| `ReservingComposer`, `CoinReservations`                                     | coin reservation for concurrent payments                 |
| `computeBinding`, `bindingsEqual`                                           | binding of a payment to one request                      |
| `hubCall`, `startHeartbeat`, `parseHistory`, …                              | hub access with timeouts and validated answers           |

Scheme specs, the facilitator, the seller SDK and the CLI:
[github.com/Taump/obbyx](https://github.com/Taump/obbyx).

Node.js ≥ 24. MIT.
