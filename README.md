# Thor

Thor is a Windows desktop workspace for office tasks, built from AionUi with replaceable agent adapters. Public development uses synthetic mail, attachments, and MCP fixtures. Enterprise connectors and credentials stay outside this repository.

The desktop, application host, and agent adapters have separate ownership. The first local runtime is Codex; an existing enterprise Claude wrapper can be configured later without changing the desktop.

This repository is under active implementation. Release and acceptance evidence will be recorded in `docs/verification/`.

## Layout

- `desktop/aionui`: pinned AionUi source and desktop integration
- `host/aioncore`: pinned AionCore application host
- `agent/adapters`: runtime integration
- `integrations`: public MCP implementations and synthetic fixtures
- `contracts`: task, approval, artifact, and capability contracts
- `release`: reproducible Windows packaging and release tooling
- `tests`: contract, packaged-app, update, and feedback tests

Upstream licenses and notices are retained in their source trees.
