# Playground

The demo seller includes a page that runs a **real testnet payment** and shows
every step: the request, the `402` offer, the signed payment (unit hash or
channel), the facilitator's settlement and the response.

```sh
# 1. a facilitator (see the quickstart)
pnpm --filter @obbyx/facilitator db:migrate
node apps/facilitator/dist/main.js

# 2. the demo seller with the playground; the buyer is a testnet wallet
PAY_TO=<seller address> SELLER_SECRET=<32+ chars> \
PLAYGROUND_BUYER_HOME=~/.obbyx \
node apps/demo/dist/server.js
```

Open <http://127.0.0.1:3402/playground>.

- **Pay and call** pays the route price from the buyer wallet and calls it.
- **Only show the offer** sends the request without paying and shows the 402.
- If the payment is not final within 20 s (testnet), the page shows it as
  pending; **Retry pending payment** repeats the request with the same
  payment. It never pays twice.
- With an open channel from the buyer to the seller (`obbyx channel open`),
  the playground pays with the channel instead of an on-chain unit.

Safety: the playground is enabled only with `PLAYGROUND_BUYER_HOME`, only on
testnet and only when the demo listens on a loopback address, because it
spends the buyer wallet. One run at a time; each run may spend at most the
route price. Keys and full units never leave the server.

The playground shows x402 **v2**: the seller middleware (like the official
`@x402/express`) offers v2. x402 v1 is supported by the facilitator and the
client for `exact`; see [x402 compatibility](./x402-compatibility.md).
