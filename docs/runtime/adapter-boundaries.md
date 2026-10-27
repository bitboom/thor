# Public agent and headless adapter check

`agent/tools/verify-adapters.mjs` registers a second synthetic ACP agent through
Core's public custom-agent API, creates a conversation through the same assistant
catalog/payload used by the desktop, and drives HTTP plus WebSocket events from
an independent Node process. It leaves native Codex conversations intact and
compares their existing history hashes before and after the check.

Run it against a dedicated local Core with a fresh synthetic scratch directory:

```powershell
node agent/tools/verify-adapters.mjs --core-url http://127.0.0.1:25987 --directory C:/synthetic-thor-check --state C:/synthetic-thor-check/evidence.json
```

The caller supplies `THOR_CORE_LOCAL_TOKEN` for a capability-protected local
Core. The helper sends it in `X-Thor-Local-Token` on HTTP and WebSocket requests
and does not print it. Scratch paths are examples; use a directory intended only
for synthetic verification. The helper creates its own run directory, synthetic
agent and conversation. It does not restart or terminate the caller's Core.

The mock implements ACP protocol version 1 over newline-delimited JSON-RPC:
`initialize`, `session/new`, `session/prompt`, `session/load`, `session/cancel`,
`session/update`, and `session/request_permission`. It emits multiple text
chunks, a permission request and tool-call updates. Its own persisted state
allows a real second process to load the existing session. It runs no external
tools or model. The stdio tests check cancellation followed by another turn and
loading through a separate mock process.

The live helper exercises custom-agent probing/registration, generated assistant
selection, streamed content, pending-approval recovery after WebSocket reconnect,
explicit approval response, cancellation, the next turn, runtime restart and
ACP session loading. It reads the same project's `THOR_MEMORY.md` through Core's
project-addressed file API. The result distinguishes independent headless
operation from actual desktop UI interaction. A passing check does not claim an
installed UI or a third-party agent was tested.

The source contracts are the custom-agent routes/service in
`host/aioncore/crates/aionui-ai-agent/src/routes/agent.rs` and
`src/services/custom.rs`, conversation routes/runtime in
`host/aioncore/crates/aionui-conversation`, ACP routing in
`host/aioncore/crates/aionui-ai-agent/src/protocol/acp.rs`, and desktop
`desktop/aionui/packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts`.
The helper contains the
concrete payloads; these references must be revisited when updating either
subtree's protocol.
