# Pinned OfficeCLI runtime

Thor's Core preview/conversion integration executes only the OfficeCLI release recorded in `host/aioncore/crates/aionui-office/assets/officecli.lock.json`. The initial pin is **v1.0.159**. Asset sizes and SHA-256 values were checked against the official release API asset digests and its `SHA256SUMS` file. The source is the [official release](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.159).

The Windows x64 asset is `officecli-win-x64.exe`, 33,533,864 bytes, SHA-256 `572c0a4da35333cf866fa5a2fb8259a4a2a8c9922be031d6b7a86936282ef94e`.

Run this **during the build**, after preparing Core and Node:

```text
node agent/tools/prepare-officecli.mjs --bundle /absolute/core-bundle --target win32-x64
```

The script installs the verified asset and pinned upstream license into `managed-resources/officecli/v1.0.159/`. It serializes concurrent builds, bounds the response size, checks the complete digest before publishing, cleans partial downloads, and reuses a verified file while offline. A corrupt build artifact is replaced only after a fresh download passes validation. There is no runtime download or installer path.

The patched Core resolves the file from its existing bundled-managed-resources root. Both preview/watch and PPT conversion require the same verified resolver. A configured conversion executable must satisfy the same pin; it cannot bypass validation. Missing, partial, unsupported, or checksum-mismatched binaries fail explicitly. Core does not search PATH or global OfficeCLI installation locations and does not contact a latest-release endpoint. The old update callback now performs local validation only.

Both command builders set `OFFICECLI_SKIP_UPDATE=1`. This is grounded in OfficeCLI v1.0.159's [UpdateChecker.cs](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.159/src/officecli/Core/UpdateChecker.cs): `CheckInBackground` and `RunRefresh` return immediately for this setting. This also avoids those paths refreshing globally installed skills. Thor does not call OfficeCLI's `install` or `skills install` commands.

The actual downloaded Windows binary reported `1.0.159`; its `watch --help` confirmed the live preview command. Downloader tests exercise checksum mismatch, truncated/oversized responses, network failure, offline reuse, corrupt cache replacement, and concurrent builders. Rust tests cover pin integrity, same-size tampering, partial/missing files, configured-path rejection, and the self-update environment setting.

An upstream prebuilt Core does not contain this patch. Final release packaging must compile the modified `host/aioncore` and place that binary in the complete local bundle before passing `AIONUI_BACKEND_LOCAL_BUNDLE_DIR` to the desktop packager. The release pipeline owns the exact MSVC build evidence. This policy covers Core's preview/conversion entrypoints; it does not limit arbitrary commands a user separately asks an agent to run.
