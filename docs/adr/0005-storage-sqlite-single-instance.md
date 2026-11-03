# ADR-0005: Storage — SQLite only, single facilitator instance

- Status: accepted
- Date: 2026-11-03

## Context

pay-per-call-API stores everything in ocore's SQLite; aa-channels-lib switches
to MySQL only in its high-availability mode, because several front instances
must share state. A first plan draft used Postgres for multi-instance row
locks; the user chose SQLite only.

## Decision

- Facilitator: `node:sqlite` (built into Node 24), WAL, `synchronous=FULL` for
  payment tables, writes in `BEGIN IMMEDIATE` transactions plus an in-process
  mutex per `(network, aa)` / `(network, unit)`.
- **One facilitator instance per database file**, enforced at startup by an
  exclusive lock (lock file + `PRAGMA locking_mode=EXCLUSIVE`); a second
  instance exits with an error instead of running unsafely.
- Watcher: ocore's SQLite (aa-channels-lib) or its own SQLite file.
- CLI and client SDK: local SQLite / files.
- Backups: scheduled online backups (`VACUUM INTO`); restore procedure in the
  runbook, reconciled against watcher cursors and sellers' `consumed_proofs`.
- Concurrency tests: parallel requests within one process, and a second
  process on the same file must fail to start.

## Consequences

- No horizontal scaling or HA in the first release; availability comes from
  fast restart plus outbox recovery.
- Storage stays behind the `PaymentStore` port, so a server database can be
  added later without touching payment logic.
