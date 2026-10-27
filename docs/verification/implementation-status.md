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
- Root runtime/release tests passed locally: 103 tests on the pending working-tree candidate. The full Core workspace also passed Windows GNU Clippy with all targets and warnings denied. These results are not evidence of a successful MSVC build or executable test.
- Actual Electron 43.8.3 hidden-window checks passed authenticated Core transport against a synthetic server, real CDP guest operation, hostile caller rejection, sandbox configuration and PDF blob loading. The final harness exited naturally through `app.quit`; its PDF guest had already been destroyed by navigation. This is not installed-app lifecycle acceptance.
- The desktop suite initially recorded 4,995 passing tests, eight skipped and two failures. One stale assertion expected the removed manual executable download; the other exceeded a ten-second WSL fixture timeout under concurrent build load. The corrected assertion and bounded thirty-second timeout passed a focused rerun of both files (seven tests). The original full run is not reported as all-green. Type checking, lint and formatting passed.
- A real GitHub defect was [created and read back as issue #1](https://github.com/bitboom/thor/issues/1). Its submission used the GitHub integration, not the installed app's feedback screen.

## Current build and security work

The [second Windows run](https://github.com/bitboom/thor/actions/runs/40540906454) passed 53 runtime/release tests, then failed Core Clippy on Windows-specific unused imports/helpers and unreachable test code. Targeted platform guards corrected these failures; local Windows GNU Clippy now passes without disabling warnings. The installer was not built by that run.

Independent review found the initial local Core channel insufficiently isolated. Revisions `ab419fe7277ff23147583eeca05e06c0b2a39c59` and `356eff881f8e670bd7091c54591c2cd452c1e08e` are diagnostic source only and must not be released. The reviewed candidate adds a per-child capability, trusted-main-window delivery, scoped helper compatibility, guest separation, CDP Host/Origin guards, private proxy header filtering and a disabled unauthenticated WebUI proxy. Current publication policy requires actual HTTP/WebSocket evidence bound to the bundled Core executable, even when promoting an older source revision.

Electron is pinned to 43.8.3. The old SQLite addon failed an actual load because it used ABI 137 while this Electron requires ABI 148. The release pipeline now requires an exact-runtime source rebuild, a synthetic database reopen test, matching packaged native bytes and the same test under packaged `Thor.exe`. This gate has rejection-path tests; successful native compilation and packaged execution still require Windows CI.

## Remaining observations

Installation, visible app operation, app-button updates and data preservation, app feedback submission, and the subsequent issue-fix-release-update loop have not passed. The Windows UI helper currently fails with `codex app-server exited before returning response 1`; browser binding also failed. A browser policy separately rejected opening a local HTML file. These failures were not bypassed or counted as successful tests.

Corporate model, mail/DRM, cookie skills, company networking and trusted Windows signing need the corresponding external environment. The public synthetic checks do not verify those integrations.
