# Thor contributor instructions

## Product boundaries
- Preserve the independent `desktop`, `host`, and `agent` boundaries. Reuse the AionUi/AionCore implementation before adding a new service.
- Never commit real mail, documents, credentials, cookies, private endpoints, machine paths, or unredacted logs. Use synthetic fixtures only.
- Keep upstream license and NOTICE files intact. Record pinned source revisions and local changes.
- User state must remain outside install and source directories. Updates must preserve projects, history, settings, memories, and user extensions.
- A passing mock test is not evidence that an enterprise integration works.

## Work allocation
- Research, architecture, and independent acceptance review: Astra xhigh.
- Runtime, contracts, persistence, release/update implementation: GPT-6.1 SOL.
- Desktop integration, preview/settings/feedback UI, fixtures and task-specific tools: GPT-6.1 Terra.
- Agents must coordinate file ownership. Do not overwrite another agent's changes.

## Quality gates
- Use real MCP protocol tests and installed Windows app checks for the public workflow.
- Exercise agent cancellation/resume, restart persistence, update data preservation, and feedback redaction.
- GitHub feedback uses reviewed sanitized payloads. No hardcoded credentials.
- Do not treat a failed, cancelled, or unverified task as completed.
- Keep documented limitations precise. Production signing and enterprise authentication must not be claimed without evidence.
