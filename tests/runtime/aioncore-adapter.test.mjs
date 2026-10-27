import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { syntheticMailRegistration, registerSyntheticMail, codexConversation, createLocalCoreClient } from '../../agent/adapters/aioncore.mjs';
import { tools } from '../../integrations/synthetic-mail/tools.mjs';

const options = { runtimeExecutable: process.execPath, serverPath: fileURLToPath(new URL('../../integrations/synthetic-mail/server.mjs', import.meta.url)) };

test('Core registration emits exact stdio DTO and explicit Electron Node mode when requested', () => {
  const registration = syntheticMailRegistration(options);
  assert.equal(registration.transport.command, process.execPath);
  assert.deepEqual(registration.transport.args, [options.serverPath]);
  assert.equal(registration.enabled, true);
  assert.equal(registration.builtin, false);
  assert.equal(registration.transport.env, undefined);
  assert.deepEqual(syntheticMailRegistration({ ...options, electronRuntime: true }).transport.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.throws(() => syntheticMailRegistration({ ...options, serverPath: './relative.mjs' }), /absolute path/);
});

test('registration tests discovery before storing through Core import and never syncs global agent config', async () => {
  const calls = [];
  const api = { async post(route, body) {
    calls.push({ route, body });
    if (route === '/api/mcp/test-connection') return { success: true, data: { success: true, tools } };
    if (route === '/api/mcp/servers/import') return { success: true, data: [{ ...body.servers[0], id: 'mcp_synthetic_test' }] };
    throw new Error('Unexpected endpoint');
  } };
  const { server } = await registerSyntheticMail(api, options);
  assert.equal(server.id, 'mcp_synthetic_test');
  assert.deepEqual(calls.map(call => call.route), ['/api/mcp/test-connection', '/api/mcp/servers/import']);
  assert.equal(calls[0].body.enabled, undefined);
  assert.equal(calls[1].body.servers[0].enabled, true);
});

test('a failed MCP handshake cannot store a definition or falsely report registration', async () => {
  let count = 0;
  await assert.rejects(registerSyntheticMail({ async post() { count++; return { success: true, data: { success: false } }; } }, options), /connection test failed/);
  assert.equal(count, 1);
  await assert.rejects(registerSyntheticMail({ async post() { return { success: true, data: { success: true, tools: [] } }; } }, options), /incomplete tool catalog/);
});

test('conversation uses existing Core Codex backend and explicit MCP selection', () => {
  const payload = codexConversation({ workspace: fileURLToPath(new URL('../../', import.meta.url)), mcpServerId: 'mcp_synthetic_test' });
  assert.equal(payload.type, 'acp');
  assert.equal(payload.extra.backend, 'codex');
  assert.deepEqual(payload.extra.mcp_server_ids, ['mcp_synthetic_test']);
  assert.equal(payload.extra.cli_path, undefined);
});

test('headless local client rejects non-loopback origins and credential-bearing URLs', () => {
  for (const url of ['https://example.invalid', 'http://127.0.0.1.evil.invalid', 'file:///tmp', 'http://user:secret@localhost:1234', 'http://localhost:1234/prefix', 'http://localhost:1234/?secret=value']) assert.throws(() => createLocalCoreClient(url));
  assert.ok(createLocalCoreClient('http://127.0.0.1:1234'));
  assert.ok(createLocalCoreClient('http://[::1]:1234'));
});
