# Public implementation status

This is a progress record, not an installed-product acceptance certificate. The complete criteria remain in [ACCEPTANCE.md](ACCEPTANCE.md). Evidence from the reference Core, a synthetic protocol peer, a development Electron process and an installed Thor release must be kept separate.

## Repository and architecture

The public repository is [bitboom/thor](https://github.com/bitboom/thor). The pinned AionUi desktop lives in `desktop/aionui`, the application host in `host/aioncore`, and adapter and project-memory tools in `agent`. Synthetic mail MCP fixtures live in `integrations`; private connectors and credentials are not included.

The [source reconstruction run](https://github.com/bitboom/thor/actions/runs/40539153033) completed and its canonical source digest matched the local source. Source publication is complete. No installer release has been published as of this record.

## Executed checks

- Real stdio MCP initialization, tool discovery/calls, pagination, malformed requests, process isolation and simulated attachment authorization were exercised.
- An existing authenticated Codex runtime executed synthetic mail tasks through the reference AionCore. Cancel/resume and restart history were exercised. A separate task persisted 50 completed `mail_read` calls and its completion marker. Forced-crash recovery was not part of that run.
- The project-memory store exercised 20 entries, concurrent writers, five reopen checks, updates/deletions, credential rejection and explicit recovery of a killed writer. Native model recall after five patched-Core restarts remains pending.
- A source-built OfficeCLI derivative passed 30 denied HTTP requests while preserving the document hash. Authorized CLI edits were flushed and persisted. Eighteen synthetic Office files passed structural validation. Installed preview fidelity and native Office editing were not verified.
- The final runtime/release contract suite passed 106 tests. The combined Core candidate passed Windows GNU Clippy with all targets and warnings denied, including the new recovery and update gates. This is a compile/static check; exact-source MSVC executable tests remain a separate release gate.
- Actual Electron 43.8.3 hidden-window checks passed authenticated Core transport against a synthetic server, real CDP guest operation, hostile caller rejection, sandbox configuration and PDF blob loading. The final harness exited naturally through `app.quit`; its PDF guest had already been destroyed by navigation. This is not installed-app lifecycle acceptance.
- The latest full desktop run on `c49ce51d14831604f1014a3eb3400d853fd9f2da` passed 5,019 tests with eight skipped and no failures (526 passing files and one skipped file). This includes the update reservation, silent Windows relaunch, feedback readback and shared-file path redaction changes. Full type checking, lint error checks and formatting passed. Earlier i18n validation passed with five existing untranslated-key warnings; the latest redaction patch changes no locale text. These are source tests, not installed UI observations.
- A real GitHub defect was [created and read back as issue #1](https://github.com/bitboom/thor/issues/1). Its submission used the GitHub integration, not the installed app's feedback screen.

## Current build and security work

The [third Windows run](https://github.com/bitboom/thor/actions/runs/40545798481), on source `235ddc9f19ef536ba40f0b288a56c17cd73da87f`, passed 103 runtime/release tests and the full MSVC Clippy gate. The first Rust test crate then reported 974 passes and one failure: its default-working-directory test compared Git Bash's `/tmp/...` spelling to a native Windows path. The replacement checks a uniquely named relative file and exact contents, with a wrong-directory negative check. The installer was not built by that run. The earlier Windows-only lint failures were corrected without disabling warnings.

The [fourth Windows run](https://github.com/bitboom/thor/actions/runs/40552652695), on source `895c32bc38b73015c4ba3753fd99663e79ee31cb`, passed 106 runtime/release tests, MSVC Clippy and the corrected default-working-directory case. Across the executed Rust test groups, 2,156 tests passed, 12 were ignored and one failed before the workspace run stopped. The failure was an extension-import assertion that looked for `/skills/users/` in a native Windows path. No Core diagnostic bundle or installer was produced. Windows test execution has therefore progressed, but the complete workspace and packaged gates have not passed.

A separate [feedback defect, issue #2](https://github.com/bitboom/thor/issues/2), was reproduced using synthetic UNC and file-URL paths. The reviewed fix in `c49ce51d14831604f1014a3eb3400d853fd9f2da` redacts those paths and their JSON-escaped forms before draft review. Independent checks covered comma/apostrophe filenames, repeated preparation and report-ID boundaries. This issue was created and read through the GitHub integration; it does not establish an installed-app feedback submission.

Independent review found the initial local Core channel insufficiently isolated. Revisions `ab419fe7277ff23147583eeca05e06c0b2a39c59` and `356eff881f8e670bd7091c54591c2cd452c1e08e` are diagnostic source only and must not be released. The reviewed candidate adds a per-child capability, trusted-main-window delivery, scoped helper compatibility, guest separation, CDP Host/Origin guards, private proxy header filtering and a disabled unauthenticated WebUI proxy. Current publication policy requires actual HTTP/WebSocket evidence bound to the bundled Core executable, even when promoting an older source revision.

Electron is pinned to 43.8.3. The old SQLite addon failed an actual load because it used ABI 137 while this Electron requires ABI 148. The release pipeline now requires an exact-runtime source rebuild, a synthetic database reopen test, matching packaged native bytes and the same test under packaged `Thor.exe`. This gate has rejection-path tests; successful native compilation and packaged execution still require Windows CI.

The next candidate records accepted turn intent with the user message, preserves partial output on restart and reports unconfirmed remote outcomes without automatically replaying work. Some mid-turn inputs remain unconfirmed when delivery cannot be durably associated with a completed result; the restart warning must not be read as proof that the operation failed. A synthetic ACP harness exercises actual Core process termination before dispatch, during output and after a persisted result. It is now a bounded Windows CI step; candidate runtime acceptance remains pending until it runs successfully.

Explicit Windows updates reserve Core's work gate before launching a silent installer and relaunching Thor. Ordinary app quit does not install a downloaded update. For this preview, any agent runtime use in the current Core process requires finishing work and restarting Thor before installation, because an opaque CLI continuation cannot safely be inferred idle from a UI label. Uncertain installer launch retains the reservation and asks for restart. The downloaded update remains available. Feedback recovery now verifies the complete reviewed title and body, not only a report ID.

## Remaining observations

Installation, visible app operation, app-button updates and data preservation, app feedback submission, and the subsequent issue-fix-release-update loop have not passed. The Windows UI helper currently fails with `codex app-server exited before returning response 1`; browser binding also failed. A browser policy separately rejected opening a local HTML file. These failures were not bypassed or counted as successful tests.

Corporate model, mail/DRM, cookie skills, company networking and trusted Windows signing need the corresponding external environment. The public synthetic checks do not verify those integrations.
