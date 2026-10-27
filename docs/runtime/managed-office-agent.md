# Managed OfficeCLI in agent sessions

Normal Thor agent initialization asks the existing Office domain to resolve its
managed OfficeCLI. The resolver requires the approved read-only watcher derivative,
canonicalizes the executable path, and checks size and SHA-256 against the lock
embedded in Core at build time. There is no PATH search, runtime download, installer,
global configuration change, command wrapper, or second copy of the executable.

The app composition adapter injects this capability through the existing agent
factory. Native Codex/Claude sessions and ordinary ACP sessions receive the same
reserved environment and appended instructions. Existing assistant rules, skills,
and the native Codex project-memory policy remain in place.

| Variable | Verified bundle | Missing, tampered, or unapproved bundle |
| --- | --- | --- |
| `THOR_OFFICECLI_STATUS` | `verified` | Stable `OFFICECLI_*` error code |
| `THOR_OFFICECLI_PATH` | Canonical absolute native executable path | Empty |
| `THOR_OFFICECLI_VERSION` | Pinned release version | Empty |
| `THOR_OFFICECLI_SHA256` | Compiled-lock digest | Empty |
| `THOR_OFFICECLI_SIZE` | Compiled-lock byte size | Empty |
| `OFFICECLI_SKIP_UPDATE` | `1` | `1` |
| `OFFICECLI_WATCH_READ_ONLY` | `1` | `1` |
| `OFFICECLI_WATCH_ALLOWED_HOSTS` | Empty | Empty |

Reserved metadata keys are removed case-insensitively before the trusted runtime
overlay. Explicit empty values also shadow inherited capabilities on failure.
Other chat work and separately authorized Office MCP or BYO tools remain available
under their existing permissions. This policy only governs Thor's bundled OfficeCLI.
The agent explains a bundled-capability error and requires a verified Thor
reinstall/update to restore that capability, without substituting a global
executable or downloading a replacement.

The existing shell tool invokes the exact path as one executable argument. For
PowerShell, use `& $env:THOR_OFFICECLI_PATH ...`; for POSIX shells, use
`"$THOR_OFFICECLI_PATH" ...`. Skill examples using `officecli` are shorthand for
this supplied executable. Authorized CLI document edits remain available while
the preview HTTP listener remains read-only. Existing shell permissions and
sandbox restrictions still apply.

This verifies the bundle at agent initialization. It does not intercept arbitrary
agent shell commands or guarantee that the file cannot change later. Core's own
preview/conversion paths continue verifying through their existing resolver.

The new source tests exercise missing, same-size tampered, partial, and unapproved
assets; canonical paths with spaces; reserved-key precedence in native and ACP
spawn assembly; inherited Windows case variants; and preservation of existing
assistant instructions and skills. Actual model-driven file read/edit and the
installed desktop workflow require the newly built MSVC candidate; source checks
alone are not runtime acceptance evidence.
