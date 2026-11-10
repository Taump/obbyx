# ADR-0001: Trust model

- Status: accepted (MVP)
- Date: 2026-11-03

## Context

obbyx is a non-custodial x402 facilitator for Obyte: funds always go to the
seller (`payTo`) directly. Micropayments use the deployed AA-channel base
agent `4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ` (aa-channels-lib, v1.1, identical on
mainnet and testnet).

The base AA has a property that shapes the whole trust model: during a
disputed close, a **fraud proof is accepted from any address and the entire
channel balance is paid to `trigger.address`** (`fraud_proof` case of the AA,
no `$bFromParties` check). Any holder of a client-signed package with a higher
`amount_spent` than the initiator declared can therefore take the channel
funds. "The facilitator never submits fraud proofs" is a policy, not a
technical guarantee. Confirmed in a local aa-testkit network:
`aa/test/test_obbyx_binding.oscript.js`, test 2 — an unrelated address receives the whole
channel balance with a higher client-signed package.

## Decision

| Party              | Trusted for                                                                                         | Not trusted for                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Hub / light vendor | Reading ledger state: inputs, last ball, AA state vars, MCI, last stable MCI; relaying `post_joint` | Nothing that can be checked locally (hashes, signatures, profile) |
| Facilitator        | **Custody of channel payment packages (explicit seller consent, ToS)**; honest verification         | Moving funds: it never signs AA triggers                          |
| Seller watcher     | Closing channels, confirming closes, submitting fraud proofs                                        | —                                                                 |
| Client             | Nothing: everything it signs is checked against on-chain data                                       | —                                                                 |

Controls on the facilitator side (MVP, implemented):

- packages are encrypted at rest (AES-256-GCM, key in `PACKAGE_KEY_FILE`, mode
  0600, the package hash as associated data); a database copy without the key
  reveals no package. A wrong key or a tampered row fails closed;
- there is no API, dashboard or role that can read stored packages: they leave
  the facilitator only towards the **seller's own watcher** over the
  authenticated `/watcher` connection (ownership-checked);
- every read of a stored package is journaled (`events`, kind `package_read`,
  with the operation and a fingerprint);
- logs contain only package fingerprints (`sha256:…`);
- the facilitator code paths contain no code that builds or sends AA triggers
  (`close`, `confirm`, `fraud_proof`) or composes channel units; enforced by
  `apps/facilitator/test/no-aa-triggers.test.ts` in CI.

Update (MVP scope): the earlier plan of a separate reader role and seller
registration through a dashboard was dropped together with the dashboard. A
seller accepts this trust by enabling channel offers (`batch` option of
`ObytePaywall`) on a facilitator it chooses; the guides state the risk.

## Consequences

- Sellers accept this trust explicitly by enabling channel offers (see the security guide).
- The risk window is only a _disputed close initiated by the client_; it is
  bounded by the channel `timeout`.
- Replacement path: AA v1.2 whose fraud-proof payout goes to the wronged party
  regardless of the submitter. Needs aa-testkit tests, a separate review and a
  deployment on both networks; the AA version then becomes part of
  `PaymentRequirements.extra`.
- Hub trust can be reduced later by cross-checking several hubs or running an
  own ocore node (see ADR-0002 on finality).
