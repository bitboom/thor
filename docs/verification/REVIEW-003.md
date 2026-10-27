# Independent freeze review 003

- Date: 2026-10-28. Scope is the latest working-tree corrections before source bootstrap and real Windows CI, not release approval.
- No product edits, commits, remote actions or installed-UI execution by this reviewer. REVIEW-002 remains the historical rationale; the status below supersedes its open-source-finding list for this inspected snapshot.
- Decision: **no new source-bootstrap/build-integrity blocker found in this focused pass**. Two final corrections below were sent to their owners before freeze. This is not a product or release PASS.

## Two remaining corrections at inspection

### F01 — P1: Serialize the feedback journal's reserve/resolve/outcome operations

- File: `desktop/aionui/packages/desktop/src/process/bridge/feedbackBridge.ts:256-261,279-295,303-338`.
- Fixed portions: sanitized draft and UUID are durable before dispatch; successful URL/state is atomically renamed into the journal before the IPC result; reopening restores pending/submitted work; explicit archive replaces automatic deletion. The former success-deletion crash window is removed.
- Remaining interleaving: submission adds its in-flight marker only **after** awaiting reservation. During reservation, resolve can read the visible journal before the marker is set. Resolve itself does asynchronous read/check/unlink without reserving the journal operation; competing resolves and a subsequent new reservation are not serialized. Thus an old operation may remove or replace a newer report's journal.
- Required: serialize journal state transitions with a shared operation lock/queue, including reservation, resolution and outcome commit. Keep the remote-operation in-flight flag across network activity and check identity under the same journal lock. Register protection before the first reservation await. Do not hold the journal mutex through the entire network wait if this would prevent safe status reads.
- Targeted regression: pause reservation write and issue resolve; race two resolves with a new submission; attempt resolve while POST/verification is active; inject failure before and after outcome persistence. Preserve the current report and never permit an unjournaled dispatch or removal of another report.
- Terra is implementing this correction. This is a source-level concurrency finding, not a demonstrated public duplicate issue.

### F11 follow-up — P1: Quoted Authorization header remains a credential-filter gap

- File: `agent/memory-store.mjs:12` at reproduction.
- Independent execution now rejects all three original cases with `SENSITIVE_DATA`: Basic Authorization header, quoted JSON token, and `github_pat_` value.
- The additional common representation `{"Authorization":"Basic CANARY_BASIC"}` is still accepted because the header alternative does not allow a closing quote before the colon and the generic sensitive-key alternative omits authorization.
- Required: reject quoted Authorization header/value forms, add this exact synthetic regression, and confirm no value is saved or echoed in an error. SOL is implementing the correction.
- This guard remains a bounded denylist; it cannot establish that arbitrary free text contains no sensitive material.
- Freeze follow-up: SOL's quoted-header correction arrived before this report was finalized. The reviewer reran the exact quoted Authorization canary against the frozen file and observed `SENSITIVE_DATA`. **F11 is closed for the reproduced source-level cases; F01 serialization is the remaining correction.**

## Corrections confirmed in source

- **F10:** the legacy manual executable-download IPC now always returns failure (`updateBridge.ts:425-431`). Manual UI actions open the fixed Thor releases page; notification/About install actions no longer execute a manual downloaded path. The supported in-app installer is electron-updater. This closes the inspected unverified in-app manual-install path; actual updater rejection/install behavior still needs installed testing.
- **F14:** Office repair URL now points to Thor releases, global install-script guidance is disabled, and missing/bad bundled runtime guidance says to reinstall/update Thor.
- **F12:** explicit recovery records/checks writer PID and nonce, refuses live/unknown owners, and leaves committed memory unchanged when recovering a dead writer. A recovery process killed while holding its separate recovery lock still requires manual lock inspection; automatic removal is deliberately absent. This residual liveness limitation is not a source-bootstrap blocker.
- **Continuous memory:** current policy automatically retains concise stable facts/preferences/decisions directly supplied by the user; origin/mode metadata rejects `external + automatic` retention and permits external retention only as an explicit request. Existing entries remain untrusted data. The origin label is supplied by the caller; the store does not independently prove the provenance of arbitrary text. Real agent selection/retention accuracy and confidential-data boundaries remain acceptance work.
- **Office/build/bootstrap:** fresh pinned source checkout, exact patch/dependency-lock checks and isolated MSBuild imports remain in place. The release builds the derivative, embeds its generated lock in Core, records matching lock hashes and invokes the listener verification script before packaging. Bootstrap still verifies canonical reconstructed source and uses a guarded non-force publication. No new integrity regression was found in this focused pass.

## Evidence actually observed

- Independently ran `node --test tests/runtime/project-memory.test.mjs`: **7 passed, 0 failed**, including automatic-source boundary, concurrent writes, live-writer refusal, killed-child recovery, hardlink/junction rejection and preservation of committed facts. The five reopened stores in one test are new objects in one test process, not five full desktop restarts.
- Independently executed the four synthetic filter cases above: original three rejected, quoted Authorization accepted at the recorded snapshot. Re-run this targeted check after the owner fix.
- Read `docs/verification/local-public-evidence.json`. Root records a freshly compiled Office derivative SHA256 `2773251a53f595af0ed061071a28d6bb79cab2ec876bf02cb516cffd254bd6df`, 30 denied HTTP cases, preserved document hash and successful authorized CLI edit/close. This is **owner-supplied actual compiled-dependency evidence**, not reviewer execution, browser-CSRF validation or installed desktop evidence.
- The same evidence file explicitly records `installedDesktopVerified: false`, scaffold-only Actions run `40537555736`, and Windows-build/release not yet executed. Its 50-tool-call Codex continuity evidence used the official reference Core and did not test forced-crash recovery. These limitations must remain attached to the results.

Next action is the two targeted corrections/retests, then source freeze/bootstrap and real Windows CI. Installed UI, app feedback issue, n→n+1→n+2 updates, state preservation, per-Thor Codex persistence isolation and private integration/signing checks remain separate gates. Do not convert this review into a release approval.
