# Upstream integration

Thor is an independent repository. `desktop/aionui` and `host/aioncore` are
squashed Git subtrees pinned by `upstream.lock.json`; the repository itself is
not a GitHub fork. `agent/` owns adapters and `integrations/` owns MCP providers.

The desktop uses the AionUi source revision in the lock. Windows releases compile
the modified `host/aioncore` subtree from the checked-out Thor commit using the
locked Cargo dependencies. An incomplete local Core bundle is a release error.
No enterprise endpoint, cookie, mail, or credential belongs in these directories.

Thor's local changes cover product/profile identity, the private desktop-to-Core
channel, task recovery and update reservation, project memory, verified bundled
OfficeCLI discovery, synthetic MCP setup, feedback review/redaction/readback and
Windows packaging. The Windows compatibility patch also normalizes relative
file paths at the API boundary while preserving native absolute paths and Unix
filenames. Platform-specific test fixtures must retain the original behavioral
assertions; passing a source check does not establish installed acceptance.

For an upstream update, use a review branch, fetch the exact desired revision,
and apply `git subtree pull --prefix=desktop/aionui <upstream URL> <ref> --squash`.
Do the same separately for `host/aioncore`. Review Thor-specific patches, update
the lock, run contract and desktop checks, then run installed update preservation
checks before publishing. Do not combine a host upgrade with an unrelated
desktop change unless their protocol versions require it.

`node release/build-windows.mjs` first builds the OfficeCLI derivative pinned by
`release/officecli-source.lock.json`, then embeds its generated effective binary
lock into Core through `THOR_OFFICECLI_LOCK_PATH`. The reviewed OfficeCLI patch
provides the read-only watch listener. Official unpatched binaries cannot enable
watch. The effective lock is generated outside the source tree; source pins and
tracked lockfiles stay unchanged during a release build.

The build checks pinned Node and GitHub CLI archive/executable SHA256 values,
bundles the project-memory CLI, and compares the packaged Core, tools and managed
resources with the verified build. It also checks every offline Hub extension
against the SHA512 integrity in the index pinned by commit and SHA256.

Before packaging, `release/verify-core-local-boundary.mjs` starts the exact
staged Core in a fresh synthetic data/work directory with an internally generated
capability. It checks authenticated HTTP and WebSocket access, rejects missing,
incorrect and repeated credentials, foreign Host/Origin and unauthenticated
preflights, and checks CORS responses. No capability or child log is exported.
The `thor-local-capability-v1` result is bound to Core's SHA256 and included at
`bundle.core.localBoundary` in provenance. Missing or older evidence fails the
artifact verifier. CI retains a separate verified Core diagnostic artifact even
when a later desktop gate fails; a failed workflow cannot publish its installer.

Windows packaging explicitly compiles the locked `better-sqlite3` source with
the locked `@electron/rebuild` API for Electron 43.8.3. The installed Electron
binary must first report its expected ABI 148; this verified value supplies the
override required by the older locked ABI lookup table. A temporary synthetic
SQLite database must survive insert, close and reopen. The Thor `afterPack`
hook repeats that test with packaged `Thor.exe`, checks the copied native binary
hash and loads other shipped Node addons before NSIS creates the installer.
It bypasses the upstream hook's unpinned fallback download. Provenance and the
current publication controller require this `thor-electron-native-v1` evidence.

GitHub Actions runs runtime/release rejection tests, Core formatting, Clippy and
workspace tests, and the desktop quality gates before packaging Windows x64.
The root `just push` runs the local desktop and Core gates. Desktop tests use
four workers. The imported standalone Core migration-check script assumes a
standalone repository and is not used as a monorepo migration proof.

Root package, package lock and desktop versions must match; a release tag must
be exactly `v<version>`. `latest.yml` must identify the single exact installer
filename, size and SHA512 in both update fields. `thor-build.json` records the
canonical source digest, commit, upstream pins, patched OfficeCLI source/policy,
embedded lock digest, bundled resource hashes and artifact hashes.
`SHA256SUMS.txt` covers the installer, update manifest, notices, provenance and
optional blockmap. The standalone verifier checks existing bytes without
rewriting the public checksums.

The publishing job verifies the downloaded Actions artifacts, creates a draft,
downloads its assets again and verifies them before making the draft public.
Existing release assets are not overwritten by this path. The updater reads
only `bitboom/thor` releases. The build checks that the preview installer is
unsigned; publisher signing remains a separate prerequisite. Installed update
and data-preservation evidence is tracked in `docs/verification/ACCEPTANCE.md`.

A reviewed main push may request publication of an already successful Windows
run through `release/release-request.json`. Its only fields are `schemaVersion`
(1), `sourceSha` (full lowercase Git SHA), `runId` (positive integer), and
`version` (stable numeric semantic version). The control workflow accepts only
the exact successful Thor Windows main run and its single unexpired named
artifact. The current controller requires the current Core boundary proof before
running any verifier or publisher from the historical source checkout. It
rechecks source/version/hashes and main ref drift before creating a new tag and
using the existing draft/download/verify/publish sequence. Existing tags, assets
and releases are never replaced. Request-only pushes do not rebuild Windows.
No request is generated automatically by the implementation or tests.

Installers contain Thor/AionUi/AionCore license texts, NOTICE, source pins,
available dependency license/notice texts and the Node/OfficeCLI/Electron/GitHub
CLI notices. The upstream Core LICENSE and Cargo license metadata discrepancy
is preserved in the notices inventory rather than silently rewritten.

If desktop Git authentication is unavailable, `just prepare-bootstrap` prepares
a small connector seed from a clean, reviewed source commit. It records a
canonical digest of every file path, mode and Git blob identity and a binary
patch against both exact upstream trees. Its local transport inventory is
`.thor-local/bootstrap/seed-files.json`. Review and commit the generated public
manifest and patch before uploading that inventory atomically through the
authorized connector.

The one-shot seed workflow runs on a main push changing that manifest/patch, or
an explicit dispatch naming the reviewed seed SHA. It checks that main still
points to the seed, imports the pinned commits with `git subtree add --squash`,
checks and applies the patch, and refuses any canonical snapshot mismatch. It
then pushes the reconstructed source and explicitly dispatches the Windows main
build using the repository-scoped Actions token. It does not create a release
tag. Both subtrees already present means no work; a partial reconstruction is
an error. Upstream subtree metadata is retained by this route.

Thor installer failures show local diagnostics and never upload logs or read an
upstream analytics profile. Runtime failure markers use the Thor profile.
Installer process stopping is restricted to known executable paths under the
selected install directory. Synthetic ownership and hash-rejection tests do
not replace an installed Windows update test.

The initial public integration ships synthetic mail. Corporate MCP providers and
existing Claude wrappers connect through the same host interfaces but require
their own private acceptance tests. A passing synthetic test does not validate
DRM, mail permissions, or Confluence/Jira authentication.
