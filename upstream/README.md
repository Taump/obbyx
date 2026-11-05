# Upstream contribution: `@x402/obyte`

Everything that goes to [x402-foundation/x402](https://github.com/x402-foundation/x402)
(Apache-2.0), laid out at the same paths as in that repository. It does not
depend on any `@obbyx/*` package. See ADR-0007 for the plan.

| Path here | Upstream PR |
| --------- | ----------- |
| `specs/schemes/exact/scheme_exact_obyte.md` | 1: specification only |
| `typescript/packages/mechanisms/obyte/` | 2: reference implementation (`@x402/obyte`) |
| `e2e/config/mechanisms_obyte.json`, `e2e-registration.patch`, `typescript/.changeset/obyte-exact.md` | 2: e2e registration (server, client, facilitator), changeset |

`BASE_COMMIT` is the upstream commit the patch was made against.
`typescript/tsconfig.base.json` is a copy of upstream's, only so the package
type-checks here; it is not part of the contribution.

## What the package is

The `exact` scheme only (no `batch-settlement`, no x402 v1):

- client, server and facilitator classes (`ExactObyteScheme` under
  `exact/client`, `exact/server`, `exact/facilitator`), like the other
  mechanisms;
- local unit validation (`validateExactUnit`) and ledger checks through an
  `ObyteHub` interface (obyte.js `client.api` or any object with the same
  methods);
- process-local default stores (`InMemoryObyteSettlementStore`,
  `InMemoryObyteProofStore`) behind interfaces for durable implementations;
- dependencies: `@x402/core`, `obyte` (obyte.js, pinned), `zod`, `@noble/hashes`.

Reason codes and behaviour match `@obbyx/x402-obyte`, except that the
seller-side codes are namespaced (`invalid_exact_obyte_payment_reused`,
`invalid_exact_obyte_payment_already_used`, `invalid_exact_obyte_payment_in_progress`)
and the server supports the `upfront` flow only.

## Checks in this repository

```bash
pnpm upstream:check   # link deps from this workspace, tsc, vitest (73 tests), prettier with upstream's config
```

Upstream's own `pnpm build` (tsup), `lint` (eslint with jsdoc and sonarjs) and
coverage thresholds need upstream's dev dependencies and run in an upstream
checkout:

```bash
git clone https://github.com/x402-foundation/x402 && cd x402 && git checkout "$(cat ../obbyx/upstream/BASE_COMMIT)"
../obbyx/upstream/scripts/prepare-branch.sh .
cd typescript && pnpm install && pnpm --filter @x402/obyte build lint:check test test:integration
```

The e2e suite then needs a funded testnet wallet (`CLIENT_OBYTE_PRIVATE_KEY`),
a plain payee address (`SERVER_OBYTE_ADDRESS`) and a binding secret
(`SERVER_OBYTE_BINDING_SECRET`, at least 32 bytes); the facilitator is keyless.

## Before opening PRs

1. Discussion issue first (Obyte as a chain family, the unregistered `obyte`
   CAIP-2 namespace, AI assistance disclosure).
2. Signed commits, conventional commit messages.
