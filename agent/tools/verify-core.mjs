#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createLocalCoreClient, registerSyntheticMail, codexConversation } from '../adapters/aioncore.mjs';
import { cancelCoreTurn, messageText, runCoreTurn } from '../client.mjs';

const { values } = parseArgs({ options: { 'core-url': { type: 'string' }, workspace: { type: 'string' }, phase: { type: 'string', default: 'initial' }, state: { type: 'string' } }, strict: true });
if (!values['core-url'] || !values.state || !['initial', 'resume', 'cancel'].includes(values.phase) || (values.phase === 'initial' && !values.workspace)) {
  process.stderr.write('Usage: node agent/tools/verify-core.mjs --core-url http://127.0.0.1:PORT --state /absolute/test-state.json --phase initial|resume|cancel [--workspace /absolute/test-workspace]\n');
  process.exitCode = 2;
} else {
  try {
    assert.ok(path.isAbsolute(values.state), 'state must be an absolute test-state path.');
    const api = createLocalCoreClient(values['core-url'], { headers: { ...(process.env.THOR_CORE_LOCAL_TOKEN ? { 'X-Thor-Local-Token': process.env.THOR_CORE_LOCAL_TOKEN } : {}), ...(process.env.THOR_CORE_AUTHORIZATION ? { Authorization: process.env.THOR_CORE_AUTHORIZATION } : {}), ...(process.env.THOR_CORE_CSRF ? { 'X-CSRF-Token': process.env.THOR_CORE_CSRF } : {}) } });
    if (values.phase === 'initial') {
      assert.ok(path.isAbsolute(values.workspace), 'workspace must be absolute.');
      await mkdir(values.workspace, { recursive: true });
      // Never overwrite a user's existing instructions; this is a dedicated test workspace.
      const memory = `THOR_MEMORY_${randomUUID().replaceAll('-', '')}`;
      const memoryPath = path.join(values.workspace, 'AGENTS.md');
      await writeFile(memoryPath, `# Thor synthetic acceptance workspace\n\nThe invented Project Lantern memory code is ${memory}.\nWhen explicitly asked for its memory code, return that exact code.\nAll mail in this workspace is synthetic.\n`, { flag: 'wx' });
      const { server } = await registerSyntheticMail(api, { runtimeExecutable: process.execPath, serverPath: fileURLToPath(new URL('../../integrations/synthetic-mail/server.mjs', import.meta.url)) });
      const created = (await api.post('/api/conversations', codexConversation({ name: 'Thor public runtime acceptance', workspace: values.workspace, mcpServerId: server.id }))).data;
      const marker = `THOR_MAIL_${randomUUID().replaceAll('-', '')}`;
      const turn = await runCoreTurn(api, { conversationId: created.id, content: `This is an authorized synthetic-only acceptance test. Use only the connected thor_synthetic_mail tools to search for Lantern (limit 1), then read the returned message and validate its target date. Reply with ${marker}, the target date as YYYY-MM-DD, and the invented Project Lantern memory code from the workspace instructions. Do not use shell, browser, or other MCP servers.` });
      assert.ok(turn.assistantText.includes(marker), 'Final response marker missing.');
      assert.ok(turn.assistantText.includes('2030-04-18'), 'Synthetic launch date missing.');
      assert.ok(turn.assistantText.includes(memory), 'Workspace memory missing.');
      const toolRows = turn.messages.filter(message => ['acp_tool_call', 'tool_call', 'tool_group'].includes(message.type));
      assert.ok(toolRows.some(message => /mail_search/.test(JSON.stringify(message.content))), 'No persisted mail_search tool call.');
      assert.ok(toolRows.some(message => /mail_read/.test(JSON.stringify(message.content))), 'No persisted mail_read tool call.');
      const state = { version: 1, conversationId: created.id, mcpServerId: server.id, workspace: values.workspace, marker, memory, initialTurnId: turn.turnId, phases: { initial: { passed: true, realModelInference: true, mailSearch: true, mailRead: true, correctDate: true, workspaceMemory: true } } };
      await writeFile(values.state, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(`${JSON.stringify({ phase: 'initial', passed: true, conversationId: created.id, ...state.phases.initial })}\n`);
    } else {
      const state = JSON.parse(await readFile(values.state, 'utf8'));
      assert.equal(state.version, 1);
      if (values.phase === 'resume') {
        const definition = (await api.get('/api/mcp/servers')).data.find(item => item.id === state.mcpServerId);
        assert.ok(definition?.enabled, 'MCP definition did not persist.');
        const history = (await api.get(`/api/conversations/${encodeURIComponent(state.conversationId)}/messages?limit=100`)).data.items;
        assert.ok(history.some(message => message.position === 'left' && messageText(message).includes(state.marker)), 'Assistant history did not persist.');
        const memoryFile = await readFile(path.join(state.workspace, 'AGENTS.md'), 'utf8');
        assert.ok(memoryFile.includes(state.memory), 'Workspace memory file did not persist.');
        const resumed = await runCoreTurn(api, { conversationId: state.conversationId, content: 'Resume the authorized synthetic test. Use thor_synthetic_mail mail_search with query Lantern and limit 1 again. Then reply with the exact THOR_MAIL_ marker from your previous answer and the invented Project Lantern memory code from the workspace instructions. Do not invent new codes.' });
        assert.ok(resumed.assistantText.includes(state.marker), 'Conversation recall failed after restart.');
        assert.ok(resumed.assistantText.includes(state.memory), 'Workspace memory recall failed after restart.');
        assert.ok(resumed.messages.some(message => ['acp_tool_call', 'tool_call', 'tool_group'].includes(message.type) && /mail_search/.test(JSON.stringify(message.content))), 'MCP was not invoked after resume.');
        state.phases.resume = { passed: true, historyPersisted: true, mcpDefinitionPersisted: true, nativeSessionRecall: true, workspaceMemoryRecall: true, mcpAfterResume: true };
      } else {
        const cancellation = await cancelCoreTurn(api, { conversationId: state.conversationId, content: 'For this synthetic cancellation test, begin writing a very long report comparing one hundred invented planets. Do not use tools. Continue until all one hundred planets have a detailed paragraph.' });
        assert.equal(cancellation.acknowledged, true, 'Cancellation was not acknowledged.');
        const recovery = `THOR_CANCEL_RECOVERY_${randomUUID().replaceAll('-', '')}`;
        const recovered = await runCoreTurn(api, { conversationId: state.conversationId, content: `The prior turn was deliberately cancelled. Reply exactly ${recovery}.` });
        assert.ok(recovered.assistantText.includes(recovery), 'Conversation did not accept a successful turn after cancellation.');
        state.phases.cancel = { passed: true, cancellationAcknowledged: true, returnedIdle: true, subsequentTurnSucceeded: true };
      }
      await writeFile(values.state, `${JSON.stringify(state, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ phase: values.phase, conversationId: state.conversationId, ...state.phases[values.phase] })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
