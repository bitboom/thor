# Thor changelog

## 0.1.5 — candidate

- Add an explicit local export for a bounded database-identity diagnostic during the current managed startup. It is available from System settings and the startup error screen; it is not attached to feedback.
- Observe one actual SQLite connection in each reached startup phase after connection, using a generation-scoped fingerprint rather than a file path or database contents. This does not cover every connection or actions before the connection completes.
- Keep identity records out of ordinary stdout logs and startup failure details. After an identity record is observed, subsequent ordinary stdout diagnostics for that startup are suppressed; stderr remains available.

Validation is scoped to controlled tests. The local full Desktop run had two PreviewPanel import timeouts; a separate quiet retry of that suite passed. The full local Windows GNU App test could not link, so the exact candidate still requires Windows MSVC CI. Installed startup, local export and any comparison against a selected file remain unverified. This diagnostic does not repair a database or identify the database used by an earlier failed Core process.

## 0.1.4 — candidate

- Fix the legacy database handoff when a backend catalog does not yet exist: SQLite backup now includes committed WAL content that a raw main-file copy could omit.
- Preserve existing targets, unknown destination sidecars and stale temporary files. Conflicts stop the handoff; publication does not overwrite a concurrent target.
- Validate and close the temporary snapshot before publication. Keep the source read-only and use bounded backup, validation and lock waits.

Validation: the real Rust regression failed before the correction and passed afterward with SQLite 3.46.0. All 761 database-crate tests and all-target Clippy passed. The combined release still requires its own full Windows MSVC CI, artifact checks and installed acceptance.

This is a general handoff correction. It does not repair the current malformed database, establish issue #9's cause, change explicit rebuild behavior, or claim current-database retention. See [verification status](docs/verification/implementation-status.md) for evidence scope and remaining checks.
