# Independent implementation review 001

- Review date: 2026-10-28, working tree observed around 00:23 KST.
- Baseline: `e6a372f8684b730f9641374e2010f00198249b3b` plus concurrent uncommitted Thor modifications. Line numbers below identify the reviewed snapshot; owners were notified while working.
- Scope: public feedback, synthetic MCP packaging/runtime, state isolation, runtime dependency updates, and initial Windows release wiring.
- No product implementation edits, commits, remote mutations, real issue submissions, or installer execution were performed by this reviewer.
- Verdict: **not a release sign-off**. The open findings and unexecuted installed-app gates below remain.

## Open findings

### F01 — P1: Feedback submission has no durable outcome or report identity

- Files: `desktop/aionui/packages/desktop/src/process/bridge/feedbackBridge.ts:104-140`; `desktop/aionui/packages/desktop/src/renderer/components/settings/SettingsModal/contents/FeedbackReportModal.tsx:33-47`.
- Trigger: GitHub creates the issue, but the response is lost, the 30-second timer expires, or the desktop process exits before the renderer stores the returned URL.
- Evidence: every `submitThorIssue` call starts a new `POST repos/bitboom/thor/issues`. The payload contains only title/body; no stable report ID or pending record is stored. The URL exists only in React state and `close()` clears it. The latest patch hides Submit after an error, which prevents an immediate repeat in that modal but does not survive close/reopen or restart.
- Impact: duplicate public issues and loss of the relationship between the report and the created issue. Generic advice to inspect GitHub cannot satisfy the planned persistent `unknown` behavior.
- Required: persist a stable report ID and sanitized draft before dispatch; persist pending/unknown/submitted state and the result URL; include an identifiable marker in the issue; reconcile unknown outcomes before allowing another create. An unsuccessful lookup must not automatically prove that the first request was never committed.
- Verification: simulate successful remote commit followed by response loss, restart the app, then retry/reconcile; remote creation count must remain one or the operation must stay unknown. Also test two concurrent submissions of the same report.
- Owner notified: Terra desktop. Acceptance: P11, P15, P16.

### F02 — P1: OfficeCLI can replace the verified runtime independently of Thor

- Files: `host/aioncore/crates/aionui-office/src/watch_manager.rs:190-202`, `:317-330`, `:470-506`; `host/aioncore/crates/aionui-office/src/officecli_runtime.rs:12-18`, `:45-57`.
- Trigger: OfficeCLI is missing or lacks `watch`, or the existing preview session performs its version check and upstream latest differs.
- Evidence: preview automatically invokes `install_officecli`; the version check requests upstream latest and installs on a mismatch. The Windows install command fetches a remote `install.ps1` from a mutable mirror/main URL and executes it using `iex`; there is no Thor version/hash pin in this path.
- Impact: the OfficeCLI binary can change without the product update or recorded compatibility checks. Restricted-network/offline behavior and the single verified component combination are not established.
- Required: use a pinned, verified runtime and disable the independent installer/updater path. Check conversion's configured-path and global PATH fallbacks as well as preview. Failed verification must not fall back silently to latest or an unverified global executable. Preserve explicit dependency errors.
- Verification: pinned version/hash, corrupted/partial download, offline failure, concurrent first use, restart recovery, and a test showing no independent update traffic.
- Owner notified: root and SOL runtime; SOL has accepted this fix. Acceptance: P07, P08, P13, P14.

### F03 — P1 for any local Core fix: Windows packaging currently downloads upstream Core instead of compiling the modified subtree

- Files: `release/build-windows.mjs:8-12`; `desktop/aionui/scripts/build-with-builder.js:766-775`; `desktop/aionui/packages/shared-scripts/src/prepare-aioncore.js:24-25`, `:444-526`.
- Trigger: a Thor correction is made under `host/aioncore`, such as F02, and the current release command is used without a local bundle/binary override.
- Evidence: the root release script calls the upstream builder, which calls `prepareAioncore`. The default resolver uses the `iOfficeAI/AionCore` release. The checked-in host subtree is not compiled by this workflow. The helper supports a local bundle override, but the initial root build path does not supply one.
- Impact: source review and source tests can approve a fix that is absent from the installed application. The imported host commit alone does not establish the provenance of the downloaded binary.
- Required: build the modified Core and its required resources and pass that bundle to packaging; record the actual binary hash/provenance. If an unchanged upstream binary is intentionally used in an intermediate build, label it accurately and do not claim local host fixes are included.
- Verification: installed Core version/build identity and hash must match the intended build; exercise F02 through that installed binary.
- Owner notified: root and SOL runtime. Acceptance: P01, P02, P07, P13.

### F04 — P2: Feedback lacks readiness/setup handling for its GitHub CLI dependency

- Files: `desktop/aionui/packages/desktop/src/process/bridge/feedbackBridge.ts:106-110`, `:130-132`; `desktop/aionui/packages/desktop/src/renderer/components/settings/SettingsModal/contents/FeedbackReportModal.tsx:42-46`, `:64`; `desktop/aionui/packages/desktop/src/renderer/services/i18n/locales/en-US/settings.json:1429-1433`.
- Trigger: a clean Windows installation has no `gh` on the application PATH, or `gh` is installed but not logged into GitHub. Existing Codex/ChatGPT login is not GitHub CLI authentication.
- Evidence: submission directly spawns `gh` with prompts disabled. The UI presents existing CLI authentication as a prerequisite but provides no preflight/installation/login path; start errors and authentication failures become the same renderer error. Nothing in the current installer bundles or prepares `gh`.
- Impact: the main advertised feedback path fails for a clean non-developer installation without actionable diagnosis. A successful developer-PC test would not establish the clean-user flow.
- Required: expose missing executable vs unauthenticated vs repository-access vs unknown-submission states, provide an explicit safe setup route or clearly documented prerequisite, and allow checking readiness before submitting. Keep credentials in the established credential manager; never embed maintainer credentials or export authentication tokens to the renderer/logs.
- Verification: missing `gh`, installed/not logged in, authenticated, denied repository access, and network timeout. The first two must not create a pending remote-write ambiguity when nothing was dispatched.
- Owner notified: Terra desktop. Acceptance: P02, P15.

## Findings patched during this review

These are source-level/reproduction confirmations, not installed-app acceptance.

| ID | Original problem and evidence | Latest observed correction | Remaining verification |
|---|---|---|---|
| F05 / P1 | `electron-builder.yml:106` copied only `server.mjs`, which imports `mail-service.mjs` and `tools.mjs`; the service imports `fixtures.mjs`. The packaged MCP would fail module resolution. | Packaging now copies the entire `integrations/synthetic-mail` directory to `resources/thor/synthetic-mail`. | Start the server using packaged Electron's Node mode and register it from the installed UI. |
| F06 / P1 | `feedbackDiagnostics.ts` leaked trailing Cookie values, Basic auth value, a quoted JSON token, and a Windows forward-slash path. The actual exported function was executed with synthetic canaries and reproduced all four leaks. | Current function removes all four canaries; applying `prepareThorFeedback` again produces the same reviewed payload. Terra added header/JSON/slash-path handling. | Broader redaction cases and the actual IPC→GitHub payload. This does not establish detection of every sensitive free-text value. |
| F07 / P1 | Original `utils.ts:30-33` and `initStorage.ts:61-106,372` migrated shared `%TEMP%/aionui` into an empty Thor profile, then deleted the original directory. | Legacy shared-temp migration removed; temp namespace is `thor`. Source inspection confirms no remaining `migrateLegacyData` invocation. | Start Thor with a synthetic pre-existing AionUi legacy directory and prove its contents/hash are unchanged. |
| F08 / P2 | Thor registered upstream `aionui://`, potentially replacing the existing application's handler. | `deepLink.ts:10` and installer protocol now use `thor://`. macOS convenience symlinks were separately renamed to `.thor`/`.thor-config`. | Actual Windows registration/coexistence test; macOS remains outside initial platform acceptance. |

Synthetic F06 reproduction results after the fix:

```text
Cookie: session=CANARY_A; csrf=CANARY_B -> Cookie=[REDACTED]
Authorization: Basic CANARY_C        -> Authorization=[REDACTED]
{"token":"CANARY_D"}                 -> {"token":"[REDACTED]"}
C:/Users/CANARY_E/file.txt            -> [REDACTED PATH]
Second preparation of each result is identical.
```

## Checks actually executed

- `node --test tests/runtime/*.test.mjs`: **13 passed, 0 failed**. Includes real stdio MCP lifecycle, discovery, pagination, synthetic allow/deny/expiry, base64/checksums, invalid arguments, and process-local grant isolation. Core adapter tests use a fake HTTP API; they are not installed-host integration tests.
- Executed the exported TypeScript `prepareThorFeedback` function using Node's type stripping before and after the correction; results recorded above.
- Read current release workflow, artifact verifier, root build wiring, feedback IPC/UI, preview refresh path, state-path setup, and synthetic runtime modules.
- No obvious external dependency is required by the synthetic mail `.mjs` modules; they use local modules and Node built-ins. Its separate `package.json` does not require installing an SDK. This is not yet proof of Electron packaged execution.
- `verify-codex-mcp.mjs` explicitly reports `inferenceTurn:false` and directly exercises MCP through app-server. Such evidence must remain a transport/client check, not a completed model-driven Thor task.

## Remaining release evidence, not additional code findings

- No Windows installer, full desktop typecheck/test/build, real Thor UI session, update cycle, or real feedback issue was executed by this reviewer. P02/P03/P07/P14/P15/P17 remain unproven here.
- Root owns the update-feed conversion; it was not duplicated as a finding. The newly added release workflow and artifact verifier were read, but their Actions result and downloaded artifacts were not available in this review.
- Generated release notes currently describe state preservation as behavior. Keep that claim tied to actual installed n→n+1→n+2 evidence; a build/hash check alone is insufficient.
- No full secret scan of imported upstream history or finished artifacts was performed. Disabling upstream Sentry initialization and automatic feedback attachments was observed in source, but outbound-network verification remains required.
- Findings were sent to their owners before this report. Re-review their final patches and installed results before closing the corresponding acceptance items.
