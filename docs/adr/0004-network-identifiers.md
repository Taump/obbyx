# ADR-0004: Network identifiers

- Status: provisional
- Date: 2026-11-03

## Context

x402 v2 identifies networks with CAIP-2 (`namespace:reference`); v1 uses plain
strings. ChainAgnostic/namespaces has no `obyte` namespace. Precedents:
`cardano:mainnet|preprod`, Lightning's `lnbtc:<genesis prefix>`.

## Decision

- v2: `obyte:livenet`, `obyte:testnet`; CAIP family pattern `obyte:*`.
- v1: `obyte-livenet`, `obyte-testnet`.
- All storage, lock and dedup keys are prefixed with the CAIP-2 id
  (`networkKey()` in `@obbyx/obyte`), so a proof can never be reused across
  networks (invariant I4).

## Consequences

The identifiers may change after the x402 discussion / ChainAgnostic PR. They
are defined in one place (`packages/obyte/src/core/networks.ts`); a change is a
breaking release with a migration note.
