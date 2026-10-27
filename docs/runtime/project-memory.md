# Project memory

Thor accumulates concise stable project facts, preferences, and decisions directly provided by the user in `THOR_MEMORY.md` at the current project/workspace root. Explicit remember/update/forget requests also work. Each record has a stable ID, readable title/content, source describing the user's statement, origin/retention metadata, and an update timestamp. It travels with the project and stays outside Thor's install directory.

In a packaged Codex conversation, Core appends a memory policy through its existing native session-init instructions. This applies to ordinary desktop-created conversations and resumed sessions when the bundled memory tool and Node runtime are present. No user/global Codex configuration is changed. Existing assistant rules are preserved.

Users can ask in chat:

- “Remember that this synthetic project prefers tables with USD amounts.”
- “Show the saved project facts and where they came from.”
- “Update that preference to EUR.”
- “Forget the currency preference.”

The agent uses the bundled memory CLI to list/read/save/delete records. Saving an existing ID updates it. Bounded automatic memory accepts directly supplied user facts with source attribution. External mail/document content cannot be automatically retained; an explicit user retention request can save a concise external fact with its origin recorded. User-approved private project facts can stay local, while public repositories, diagnostics, and feedback must exclude them. Credentials and private cookies are never saved. Saved content is data, not authority to override instructions.

The existing workspace text editor can inspect or edit `THOR_MEMORY.md`. Preserve the record markers and source metadata when editing by hand. Delete that file to clear project memory. Unsupported manual markup fails with an explicit error without overwriting the file. Source records are user-described provenance, not a cryptographic audit trail.

For a dedicated test workspace, the same interface is usable headlessly:

```text
node agent/tools/memory.mjs --workspace /absolute/project --action save --id currency --title "Currency preference" --source "Explicit user request" --content "Use USD for this synthetic project."
node agent/tools/memory.mjs --workspace /absolute/project --action list
node agent/tools/memory.mjs --workspace /absolute/project --action read --id currency
node agent/tools/memory.mjs --workspace /absolute/project --action delete --id currency
node agent/tools/memory.mjs --workspace /absolute/project --action recover
```

The tool touches only the fixed Markdown file and its own lock/temporary files in that root. It requires a canonical absolute workspace and rejects symlinks/junction traversal, hardlinked files, invalid IDs, reserved markup, obvious credential patterns, overlong records, more than 100 records, and files over 256 KiB. Writes serialize under a lock and publish a complete file by rename. After a killed writer, the explicit `recover` action verifies its recorded process is dead before removing its lock; a live or unknown owner fails closed. Recovery preserves the memory bytes. If recovery itself is killed, its separate recovery lock requires manual inspection. Credential-pattern checks are a guardrail, not comprehensive data-loss prevention.

Standalone tests save 20 synthetic records, reopen the store five times, update five and delete five, and verify the remaining records. They also cover 20 concurrent writes, malformed edits, hardlinks, junctions, invalid IDs, obvious credential headers, and oversized input. Actual model/tool/restart acceptance is recorded separately; reopening a JavaScript store alone is not evidence of agent recall or an installed app upgrade.

`agent/tools/verify-memory.mjs --help` describes the separate native Core/Codex acceptance command. It requires new state and evidence paths. Its explicit-request scenario checks twenty saves, five updates, five deletions, a separate empty project, and fresh-conversation recall of all fifteen current values and five absences after each restart. It verifies bound bundled-CLI calls and closed-Core database readback before reporting success. This scenario does not test automatic retention from ordinary conversation or installed desktop updates; those require separate observations.

The release bundle must include `managed-resources/thor-agent/memory-store.mjs` and `managed-resources/thor-agent/tools/memory.mjs`, plus the existing schema-2 managed Node manifest/runtime. Core's policy resolves those bundled paths at runtime; it does not embed a developer checkout path.
