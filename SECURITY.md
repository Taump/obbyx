# Security policy

obbyx handles payments. Please report vulnerabilities **privately**:

- GitHub: use "Report a vulnerability" (private security advisory) on this
  repository;
- do not open a public issue, pull request or discussion for a vulnerability.

Include the affected component (facilitator, watcher, SDK, CLI), version or
commit, steps to reproduce and the impact you expect. Never include real
private keys, seeds or production vouchers; use testnet data.

We acknowledge reports within 3 working days and coordinate a fix and a
disclosure date with you.

## Scope

In scope: payment verification and settlement, payment binding and replay
protection, channel voucher handling and storage, the watcher's on-chain
actions, key and wallet handling, secrets in logs.

Known, documented risks (not vulnerabilities by themselves): the channel AA
fraud-proof payout and the trust it requires in the facilitator
([ADR-0001](docs/adr/0001-trust-model.md)); `FINALITY=accepted` serving before
finality.
