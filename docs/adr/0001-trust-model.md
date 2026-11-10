# ADR-0001: Trust model

- Status: accepted (MVP); amended 2026-11-10: base AA v1.2 adopted
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

## Update 2026-11-10: base AA v1.2 adopted

New channels are instances of the base AA **v1.2**
`7UXLI64FC7TMDFGIZZ34GIJHZIGTZUZR` (`aa/channels_base_aa_1.2.oscript`,
`CHANNEL_BASE_AA`; deployed on testnet, not yet on mainnet). Its only change to v1.1 is the fraud-proof payout: the
channel balance goes to **the wronged party** (the party that did not start the
close), whoever submits the proof. A leaked voucher therefore no longer lets
anyone take funds: a fraud proof built from it pays the wronged party (the
seller, when the client closed understating its spending), never the
submitter. Tested in aa-testkit (`aa/test/test_fraud_proof_payout.oscript.js`).

Consequences for this ADR:

- the facilitator is **no longer trusted for funds**: the "custody of channel
  payment packages" row below is now a **privacy** matter (a leaked voucher
  reveals who paid whom how much, nothing more);
- the controls below (encryption at rest, no read API, journaled reads,
  fingerprint-only logs, no AA-trigger code) stay; package encryption now
  protects privacy only;
- channels on v1.1 (`4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ`,
  `LEGACY_CHANNEL_BASE_AAS`) are **never paid into**: the facilitator refuses
  their vouchers (`…_channel_not_found`) and offers advertise only v1.2
  (`extra.baseAa`). They are recognised only so that existing channels can
  still be closed and defended;
- **strict voucher package profile.** A voucher the AA's
  `is_valid_signed_package` rejects is worthless to the seller (no close, no
  fraud proof), so the facilitator and the watcher verify vouchers with
  `verifyVoucherPackage`, which accepts a strict subset of what that check
  accepts (one `sig` author with an embedded definition, no
  `last_ball_unit`; see the scheme spec, "Package profile").

The text below describes v1.1 and is kept for history.

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
  regardless of the submitter. **Done** (see the update above): v1.2 is
  `PaymentRequirements.extra.baseAa`, v1.1 channels are close/defend only.
- Hub trust can be reduced later by cross-checking several hubs or running an
  own ocore node (see ADR-0002 on finality).
