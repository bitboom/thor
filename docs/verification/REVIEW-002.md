# Independent implementation review 002

- Date: 2026-10-28. Reviewed the concurrently changing Thor working tree based on `e6a372f8684b730f9641374e2010f00198249b3b`; line numbers identify the inspected snapshot and may move.
- Scope: previous findings, preview isolation, OfficeCLI source/lock boundary, feedback recovery, memory persistence, installer ownership/privacy, release/bootstrap integrity.
- This is a source review with the limited executions listed below. **It is not an installed-product, Actions/release, update-cycle, or user-final-acceptance pass.**
- Owners received findings while implementing. No product code, commit, remote mutation, issue submission, or installer execution was performed by this reviewer.

## Open findings and required evidence

### F09 — P1: Office preview needs enforcement at the listener, not only its Electron guest

- Original source: upstream OfficeCLI v1.0.159 `WatchServer.cs:1883-2034`, `:2100-2115`; Thor guest restrictions: `desktop/aionui/packages/desktop/src/index.ts:513-546`, `src/common/config/constants.ts:120` onward.
- The upstream server accepts write routes including `/api/switch`, `/api/send`, and `/api/batch`. Its Origin rule accepts loopback hosts without comparing ports; a missing Origin also passes. Root reported an actual HTTP test where a different loopback Origin changed between two synthetic DOCX files. This establishes server behavior, **not an actual browser CSRF exploit**: browser preflight/safelisted-request behavior requires a separate test.
- Electron now uses per-preview in-memory sessions, strips preloads, disables Node, enables sandbox/context isolation/web security, blocks permissions/popups, and restricts Office traffic to GET `/` and `/events` on its exact origin. Those restrictions govern that guest, not another client of the raw listener.
- Current correction: `release/officecli-readonly.patch:31-74` places a listener-level gate before dispatch, permitting only exact GET `/` and `/events`, denying Upgrade and nonmatching/opaque Origin. All POST write routes are therefore unreachable even without an Origin. It also disables automatic global installation/update and upstream CLI raw logging. A different loopback host at the same port is accepted by the server's host allowlist; guest requests remain exact-origin restricted. Do not describe this as token-authenticated server access.
- `officecli_runtime.rs:97-105` refuses preview without `readOnlyWatch`; `build.rs` embeds the generated lock. The release build now compiles the derivative, supplies its effective lock to Core, and ties the Core/Office provenance to the same lock hash. The old official binary must never regain preview through a fallback.
- Required before closure: against the **built derivative and then installed bundle**, POST every former write route with same-origin, foreign-loopback, foreign-HTTPS, null, and absent Origin; all must fail and original document hashes/selected file must remain unchanged. Test malformed/absolute/encoded paths, non-GET verbs and Upgrade. GET `/` and SSE `/events` must still work. Exercise authorized CLI edit, watch reload and close/reopen after disabling `/api/switch`. Confirm no global self-install/config/log mutation. Record derivative source commit, patch hash, binary hash and embedded Core lock.
- Owner: root + SOL. P07/P08/P13 remain unproven by source inspection alone.

### F10 — P1: Manual in-app update download bypasses artifact integrity checking

- Files: `desktop/aionui/packages/desktop/src/process/bridge/updateBridge.ts:539-575,737-771`; `src/common/update/updateTypes.ts:8-17,41-49`; `src/renderer/components/settings/useUpdateNotificationController.ts:338-378`; `src/renderer/components/settings/SettingsModal/contents/AboutModalContent.tsx:77-80`.
- The manual path downloads an allowlisted Thor release URL and considers EOF success. It does not compare a trusted expected SHA512/hash or expected file size. Its request/asset types do not carry an integrity value. The renderer marks the file install-ready and opens the downloaded executable through `shell.openFile`.
- Restricting repository/HTTPS/redirect hosts improves origin control but does not establish integrity, including truncated bodies that finish without a declared Content-Length. This separate path bypasses electron-updater's verification.
- Required: resolve and bind the authoritative release manifest in the main process, enforce version/name/size/hash, and only mark the verified artifact install-ready; alternatively remove the manual in-app executable path and use the verified updater, with a clearly separate external release-page option.
- Verification: altered/truncated executable, wrong name/version/hash and interrupted transfer must never emit install-ready or invoke open/install; valid bytes must still install. Verify the actual fallback route, not just the automatic updater.
- Owner: root notified. Acceptance: P14.

### F01 follow-up — P1: Pending ID survives restart, but successful feedback outcome and draft still do not

- Files: `desktop/aionui/packages/desktop/src/process/bridge/feedbackBridge.ts:202-214,245-255,265-290`; `src/renderer/components/settings/SettingsModal/contents/FeedbackReportModal.tsx:36-51,122-128`.
- Improvement: an exclusive pending UUID is written before CLI/browser dispatch; the issue includes a marker; restart exposes pending state; verification searches public issues for the same marker. A failed lookup leaves the outcome unresolved. Concurrent new submissions are blocked by the exclusive reservation. The browser path is an explicit human action.
- Remaining crash window: successful POST/verification deletes the pending record **before** returning the URL to the renderer. A process exit or lost IPC reply between these actions loses the report identity and result. Only the UUID is durable, so restart cannot recover the reviewed draft. Closing the modal clears title/body/result URL and generates a new UUID.
- Required: retain a durable sanitized report record with draft, report ID, pending/unknown/submitted state and URL. Persist submitted outcome before returning it; reopening must recover it. An explicit acknowledgement/archive may clear the current item later. Do not save raw diagnostics or credentials in this journal.
- Verification: remote commit followed by lost response, crash before/after local success persistence, restart, concurrent dispatch, browser opened but never submitted, and manual resolution. Never silently treat lookup absence as proof of no remote write; retain unknown or reconcile.
- Owner: Terra notified. Acceptance: P11/P15/P16.

### F11 — P1: Memory credential guard accepts common credential representations

- File at reproduction: `agent/memory-store.mjs:12-20`.
- Independently executed `serializeMemory` with synthetic values: `Authorization: Basic CANARY_BASIC`, `{"token":"CANARY_JSON_0123456789"}`, and `github_pat_CANARY_PAT_0123456789` were all accepted. These are intentionally synthetic, not real credentials.
- The guard currently advertises rejection of credentials/cookie/header values, but its Authorization alternative is Bearer-only and the generic key rule does not match a quoted JSON key. Storing these values makes them available to future memory reads/model context.
- Required: reject supported sensitive header schemes, quoted secret keys, modern token prefixes and common equivalent key names. Keep all memory text untrusted and user-reviewed; a denylist is not proof that arbitrary free text contains no private information.
- Verification: add the three concrete regressions, folded/multiline/quoted forms, benign text and save/read/reopen checks. Assert rejected content is absent from both memory and error output.
- Owner: SOL accepted and implementing. Acceptance: P10/P12.

### F12 — P2: A killed memory writer leaves an unrecoverable busy lock

- File at inspection: `agent/memory-store.mjs:102-131`.
- The writer creates `.THOR_MEMORY.lock` exclusively and removes it only in `finally`; an OS termination after acquisition leaves it indefinitely. Later writes time out as BUSY. There is no owner metadata or implemented recovery action in the inspected version.
- Required: safe explicit recovery with owner identity/liveness checks (or equivalent robust design), preserving the last committed memory. Never remove a live or unknown owner's lock merely because a timeout elapsed. Ensure recovery itself cannot delete another writer's newly acquired lock.
- Verification: kill a separate writer process after acquisition, recover, read existing committed memory, and save another fact. Test live-owner refusal, unknown/corrupt lock refusal, competing recovery and recovery-process termination.
- Owner: SOL accepted and implementing. Acceptance: P11/P12.

### F14 — P2: Office dependency repair guidance points to an incompatible upstream install

- File: `desktop/aionui/packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/OfficeWatchViewer.tsx:89,149-166,282-304`.
- Missing OfficeCLI can display an upstream release link, while web guidance gives a mutable install script. Thor now accepts only its pinned bundled derivative for preview, so installing the upstream/global binary does not repair this condition.
- Required: actionable Thor reinstall/update or verified-bundle repair guidance; preserve distinction between missing, integrity failure, unavailable read-only derivative and launch failure. Do not promise a global installation will be used. Windows desktop is the current acceptance scope.
- Owner: Terra notified. Acceptance: P02/P07.

## Source corrections confirmed; installed evidence still required

| Earlier concern | Inspected correction | Evidence still required |
|---|---|---|
| F02 independent OfficeCLI install/update | Runtime resolves pinned size/hash; no PATH/global or runtime-downloader fallback; all invocation builders force skip-update. Derived watch is additionally required. | Built/installed behavior, corrupt/missing dependency, offline operation and absence of independent traffic/global mutation. |
| F03 modified Core absent from package | `release/build-host.mjs` compiles local Core; `build-windows.mjs` forces local bundle and compares packaged component/tree hashes; same derived Office lock is embedded and recorded. | Successful source build, Actions artifacts, installed component hashes and exercise of the patched behavior. |
| F04 clean-user feedback bootstrap | Bundled pinned `gh.exe`, explicit auth status and browser issue-draft fallback. No maintainer token is embedded. | Clean user profile, no gh auth, authenticated path, browser submission/verification, access failure and offline behavior from actual UI. Codex login is not GitHub login. |
| F05 synthetic MCP missing local modules | Whole synthetic-mail directory is packaged. | Installed transport launch and actual model-driven task, not a direct transport-only script. |
| F06 feedback redaction regressions | Previous four concrete canaries were independently rejected with idempotent re-sanitization. | Actual IPC-to-public-issue body and broader synthetic leak matrix. No universal-redaction claim. |
| F07/F08 other-app state/scheme collision | Shared `%TEMP%/aionui` migration removed; Thor namespace and `thor://`; Thor-only symlink names. | Installed coexistence and state-preservation hashes. |
| Installer kills/telemetry | Process ownership is restricted to exact install-root/known bundled executables; error reporter does no network/log-content upload; app-data failure marker uses Thor. | Install/update with unrelated same-name processes and active external work; confirm unrelated PIDs survive and no outbound report. Local installer diagnostic files still contain paths and must not be published raw. |
| F13 OfficeCLI build input integrity, fixed during review | Initial cache build ignored staged/untracked changes. Latest `officecli-source.mjs:32-54` uses a fresh checkout of the pinned commit, verifies HEAD-relative patch and dependency lock hashes, and disables parent Directory.Build/Packages imports. | Clean rebuild/rejection tests and packaged binary identity; do not call compilation proof from these source guards. |
| Bootstrap source integrity | Seed/main commit match, pinned upstream commits, checked subtree-only patch, canonical reconstructed-tree digest, clean checkout and non-force push guard. Release uses downloaded-artifact re-verification before publishing draft. | Actual reconstructed commit/tree, successful Actions, downloaded published bytes and exact installed version. No actions were dispatched by this reviewer. |

## Verification limitations and next checkpoints

- Actual reviewer executions this round were source inspection and the synthetic memory-guard canaries above. The prior review records 13 runtime tests and four feedback-redaction canaries. No newer owner-reported suite count is presented as this reviewer's execution.
- Terra reported 521 files / 4,978 tests plus 8 skipped, then 49 targeted refresh tests, with type/lint/format checks. This is useful source-check evidence supplied by its owner; it does not prove a packaged UI, installer, release or update loop.
- Per-Thor Codex SQLite isolation was still forthcoming at inspection. Review the final override and ensure existing Codex login can be reused without copying/exporting credentials, while thread/session SQLite writes stay within Thor state. Check other Codex sessions remain unchanged.
- Listener hardening must retain useful preview behavior: valid DOCX/XLSX/PPTX render, fonts/assets limitation, authorized edit then refresh, file-ref and path-only identity, two-tab switching, close/reopen and no leaked process. Mocked bridge/React tests cannot prove the underlying watcher lifecycle.
- Public release gates remain actual install → UI task/MCP → feedback issue verified in GitHub → fix → next release → app-button update with project/settings/memory/extension preservation. Any confidential company integration or trusted-signing prerequisite remains separately `BLOCKED_EXTERNAL`, not passed by mocks.
