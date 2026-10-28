# Thor

Thor is a Windows desktop workspace for office tasks, built from AionUi with replaceable agent adapters. Public development uses synthetic mail, attachments, and MCP fixtures. Enterprise connectors and credentials stay outside this repository.

The desktop, application host, and agent adapters have separate ownership. The first local runtime is Codex; an existing enterprise Claude wrapper can be configured later without changing the desktop.

This repository is under active implementation. The [0.1.1 unsigned Windows preview](https://github.com/bitboom/thor/releases/tag/v0.1.1) was installed through 0.1.0's update buttons. The checked synthetic files and project/history/settings/MCP data were retained, but the first automatic relaunch showed empty state until one ordinary restart ([issue #8](https://github.com/bitboom/thor/issues/8)). The sample-mail button now appears but registration still fails ([issue #7](https://github.com/bitboom/thor/issues/7)). Live response display, model memory saving and the file tree also have observed defects; installed Office preview remains unverified. See [current verification status](docs/verification/implementation-status.md) for the exact scope. Candidate corrections require their own CI, release and installed checks.

## Layout

- `desktop/aionui`: pinned AionUi source and desktop integration
- `host/aioncore`: pinned AionCore application host
- `agent/adapters`: runtime integration
- `integrations`: public MCP implementations and synthetic fixtures
- `contracts`: task, approval, artifact, and capability contracts
- `release`: reproducible Windows packaging and release tooling
- `tests`: contract, packaged-app, update, and feedback tests

Upstream licenses and notices are retained in their source trees.
