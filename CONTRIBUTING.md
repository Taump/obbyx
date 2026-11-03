# Contributing

## Setup

Node 24 (`.nvmrc`) and pnpm (`corepack enable` or `npx pnpm@12.16.1`).

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Live testnet tests are skipped by default; run them with `OBBYX_LIVE_TESTNET=1`.

## Layout and patterns

See `docs/guide/architecture.md`: where code goes, the design patterns in use and
which module enforces each payment invariant. Validate untrusted input with zod
at the boundary; keep inner modules typed.

## Rules

- **Amounts are BigInt** (smallest units) end to end; never `number` for money.
- **Fail closed**: an unknown outcome (timeout, hub error) is "pending", never
  success and never a definite failure that releases funds.
- **No secrets in logs**: use the redacted field names or `fingerprint()`
  (see the logging guide). Never log units, vouchers or keys.
- **The facilitator never builds AA triggers**; `no-aa-triggers.test.ts`
  enforces it.
- Every behaviour change comes with a test; payment invariants come with a
  test that would fail without the change.
- Reference pages under `docs/reference/` are generated: change the code
  (zod schema `.describe()`, CLI command definitions, `http/openapi.ts`, the error
  catalog in `packages/docs-gen`) and run `pnpm docs:gen`. CI fails when they
  are out of date.
- A design decision that changes guarantees gets an ADR in `docs/adr/`.

## Changes and releases

Published to npm: `@obbyx/obyte`, `@obbyx/x402-obyte`, `@obbyx/sdk`, `@obbyx/cli`.
The apps (facilitator, watcher, demo) and `@obbyx/docs-gen` are private.

1. Add a changeset for user-visible changes: `pnpm changeset`.
2. Bump versions and changelogs: `pnpm changeset version`.
3. Check the tarballs: `pnpm release:check` → `.release/*.tgz` (contents: `tar -tzf`).
   The published manifest drops the workspace-only `@obbyx/source` export
   condition (`publishConfig.exports`) and turns `workspace:^` into `^x.y.z`.
4. Publish (needs `npm login` to an account that owns the `@obbyx` scope):
   `pnpm release` (builds, then `changeset publish`, which skips versions
   already on npm and creates git tags).
