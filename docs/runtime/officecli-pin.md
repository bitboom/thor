# Pinned OfficeCLI runtime

Thor's Core preview/conversion integration executes only a pinned, hash-verified OfficeCLI binary. The tracked baseline lock is `host/aioncore/crates/aionui-office/assets/officecli.lock.json`, version **v1.0.159**. Its asset sizes and SHA-256 values were checked against the [official release](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.159). Production watch requires Thor's source-built read-only listener derivative, whose distinct digest and source/patch provenance are recorded in a generated effective lock.

The Windows x64 asset is `officecli-win-x64.exe`, 33,533,864 bytes, SHA-256 `572c0a4da35333cf866fa5a2fb8259a4a2a8c9922be031d6b7a86936282ef94e`.

Run this **during the build**, after preparing Core and Node:

```text
node agent/tools/prepare-officecli.mjs --bundle /absolute/core-bundle --target win32-x64
```

The script installs the verified asset and pinned upstream license into `managed-resources/officecli/v1.0.159/`. It serializes concurrent builds, bounds the response size, checks the complete digest before publishing, cleans partial downloads, and reuses a verified file while offline. A corrupt build artifact is replaced only after a fresh download passes validation. There is no runtime download or installer path.

The patched Core resolves the file from its existing bundled-managed-resources root. Preview/watch and PPT conversion use the same verified resolver. Watch additionally requires `readOnlyWatch: true` for the current target; the unmodified official binary fails that gate. A configured conversion executable must satisfy the same digest; it cannot bypass validation. Missing, partial, unsupported, or checksum-mismatched binaries fail explicitly. Core does not search PATH or global OfficeCLI installation locations and does not contact a latest-release endpoint. The old update callback performs local validation only.

The release builder `release/officecli-source.mjs` pins the upstream source commit, patch and .NET SDK, then emits `effective-lock.json` with the built binary's size/digest, `readOnlyWatch`, and per-asset source metadata. Set the absolute `THOR_OFFICECLI_LOCK_PATH` to that generated file when compiling Core. The crate build script embeds the validated effective lock without changing tracked files. The matching executable and upstream license must be staged under `managed-resources/officecli/v1.0.159/`. The official prebuilt digest above does **not** describe the derivative.

The watch command sets `OFFICECLI_WATCH_READ_ONLY=1` and removes `OFFICECLI_WATCH_ALLOWED_HOSTS`. The patched listener accepts only its preview/event reads and rejects HTTP writes. Core refresh stops and restarts the watcher on the same port instead of calling a write endpoint. Authorized OfficeCLI document editing remains a separate CLI operation.

Both command builders set `OFFICECLI_SKIP_UPDATE=1`. This is grounded in OfficeCLI v1.0.159's [UpdateChecker.cs](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.159/src/officecli/Core/UpdateChecker.cs): `CheckInBackground` and `RunRefresh` return immediately for this setting. This also avoids those paths refreshing globally installed skills. Thor does not call OfficeCLI's `install` or `skills install` commands.

The actual downloaded Windows binary reported `1.0.159`; its `watch --help` confirmed the live preview command. Downloader tests exercise checksum mismatch, truncated/oversized responses, network failure, offline reuse, corrupt cache replacement, and concurrent builders. Rust tests cover pin integrity, same-size tampering, partial/missing files, configured-path rejection, and the self-update environment setting.

An upstream prebuilt Core does not contain this patch. Final release packaging must compile the modified `host/aioncore` and place that binary in the complete local bundle before passing `AIONUI_BACKEND_LOCAL_BUNDLE_DIR` to the desktop packager. The release pipeline owns the exact MSVC build evidence. This policy covers Core's preview/conversion entrypoints; it does not limit arbitrary commands a user separately asks an agent to run.
