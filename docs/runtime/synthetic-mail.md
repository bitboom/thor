# Synthetic mail MCP

`integrations/synthetic-mail/server.mjs` is a dependency-free Node 20+ stdio MCP server. It has no network client, account connection, credentials, real mail, filesystem-read API, or enterprise DRM implementation. All fixture addresses use the reserved `example.invalid` domain. Authorization is a simulation over invented in-memory text.

Run from any working directory with an absolute script argument:

```text
node /absolute/path/to/thor/integrations/synthetic-mail/server.mjs
```

Use `process.execPath` when registering from an Electron/Node host. An Electron executable needs `ELECTRON_RUN_AS_NODE=1` for this command. Hosts must resolve the packaged resource path, rather than storing a source checkout or machine-specific path.

## Tools and example flow

1. `mail_search({"query":"Lantern","limit":1})` returns message summaries, a total, and `nextCursor`. Continue with the same query and cursor. The cursor binds to query, label, and fixture version; malformed or mismatched cursors produce `INVALID_CURSOR`.
2. `mail_read({"messageId":"msg-launch-001"})` reads a message and attachment metadata. `mail_list_attachments` returns metadata alone.
3. `mail_read_attachment({"attachmentId":"att-launch-brief","encoding":"base64"})` returns filename, MIME type, bytes encoded as base64, byte count, and SHA-256. The default encoding is UTF-8 text.
4. `mail_authorize_attachment({"attachmentId":"att-budget-allowed"})` returns a process-local synthetic authorization value. Pass it as `authorization` to `mail_read_attachment`.
5. `att-drm-denied` always returns `ACCESS_DENIED`. `att-drm-expiring` grants expire after one second, including when a longer TTL is requested. `mail_reset_session({})` revokes grants; a process restart also revokes them.

Every successful/error tool result has `synthetic: true`, and its text content mirrors `structuredContent`. Tool errors set MCP `isError: true`; protocol errors use JSON-RPC error responses. Unknown IDs return `NOT_FOUND`; additional arguments and invalid types are rejected. No body is included in attachment metadata. There is no file URI/resource path that can bypass authorization.

The fixed six-tool catalog fits in one page. Search results use pagination (default 2, maximum 50). Inputs have bounded sizes; JSON-RPC lines are capped at 1 MiB. The server supports MCP protocol dates 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25 over newline-delimited UTF-8 JSON. It writes only MCP responses to stdout and does not log fixture bodies or authorization values.

## Registration without global changes

An AionCore MCP entry uses this shape after the host resolves the absolute executable and resource script:

```json
{
  "name": "Thor Synthetic Mail",
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/thor/integrations/synthetic-mail/server.mjs"]
  }
}
```

AionCore v0.2.2 accepts that envelope at `POST /api/mcp/servers`. A plain create starts disabled. Thor's `registerSyntheticMail` helper first performs `POST /api/mcp/test-connection`, checks the six-tool catalog, then calls `POST /api/mcp/servers/import` with `{servers:[{...entry,enabled:true,builtin:false}]}`. This upserts the local Core definition by the stable name `thor_synthetic_mail`; it does not call agent/global config sync. `codexConversation` explicitly selects the resulting row ID in `extra.mcp_server_ids`.

Run the same host setup headlessly against an already-running local Core:

```text
node agent/tools/register-synthetic-mail.mjs --core-url http://127.0.0.1:PORT
```

The helper defaults to its own Node executable and the checkout-relative server location. Packaged Electron callers pass the runtime/resource paths and `electronRuntime:true` explicitly. Authentication is supplied by the desktop's existing API client; the CLI optionally accepts `THOR_CORE_AUTHORIZATION` and `THOR_CORE_CSRF` environment variables without printing them.

Core's existing Codex backend maps the selected MCP definition into per-thread `config.mcp_servers` on both `thread/start` and `thread/resume`. No Codex config file write is required. For independent manual Codex setup, project-scoped `.codex/config.toml` is supported by trusted projects, but Thor does not write the user's global Codex configuration:

```toml
[mcp_servers.thor_synthetic_mail]
command = "node"
args = ["/absolute/path/to/thor/integrations/synthetic-mail/server.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 15
```

Run tests with `node --test tests/runtime/synthetic-mail.test.mjs`. Tests launch actual subprocesses and exercise initialize, tool discovery, tools/call, pagination, error recovery, metadata, content checksums, denied/allowed/expired access, grant revocation, and process isolation. A passing synthetic test does not establish any real mail, Office, identity, or enterprise DRM integration.

## Live acceptance clients

`agent/tools/verify-codex-mcp.mjs --codex /absolute/codex --workspace /absolute/test-workspace` verifies the actual installed app-server as an MCP client. It uses an ephemeral read-only thread, checks login type without exposing account details, discovers tools, and calls search/public/denied attachment tools without running model inference.

`agent/tools/verify-core.mjs` exercises the actual existing Core HTTP API. The `initial` phase requires a dedicated empty workspace and an absolute `--state` path outside the install/source directories. It creates synthetic project instructions without overwriting an existing `AGENTS.md`, registers the MCP, creates a Codex conversation, and requires actual persisted tool calls plus the correct date and random workspace memory code. The `resume` phase must be run after stopping/restarting Core with the same data directory; it requires prior history, the saved MCP definition, model recall, and a new tool call. The `cancel` phase cancels a newly submitted turn, requires an idle runtime, and then requires a successful subsequent inference turn. All phases emit only compact synthetic result metadata.

The initial three phases passed against official Core 0.2.2 and installed Codex 0.164.0-alpha.11.1. This verifies a Core process restart with the same state, not an installed desktop upgrade. The workspace `AGENTS.md` test demonstrates persisted instructions, not a complete evolving memory feature. Production enterprise identity, remote mail, DRM, a second authenticated agent backend, and an installed updater require their own evidence.

Protocol references: [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Codex reference: [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
