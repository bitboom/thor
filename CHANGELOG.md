# Thor changelog

## 0.1.4 — candidate

- Fix the legacy database handoff when a backend catalog does not yet exist: SQLite backup now includes committed WAL content that a raw main-file copy could omit.
- Preserve existing targets, unknown destination sidecars and stale temporary files. Conflicts stop the handoff; publication does not overwrite a concurrent target.
- Validate and close the temporary snapshot before publication. Keep the source read-only and use bounded backup, validation and lock waits.

Validation: the real Rust regression failed before the correction and passed afterward with SQLite 3.46.0. All 761 database-crate tests and all-target Clippy passed. The combined release still requires its own full Windows MSVC CI, artifact checks and installed acceptance.

This is a general handoff correction. It does not repair the current malformed database, establish issue #9's cause, change explicit rebuild behavior, or claim current-database retention. See [verification status](docs/verification/implementation-status.md) for evidence scope and remaining checks.
