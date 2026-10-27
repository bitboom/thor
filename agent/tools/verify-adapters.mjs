import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocketTransport from 'ws';
import path from 'node:path';
import { createLocalCoreClient } from '../adapters/aioncore.mjs';
import { waitForCoreIdle, messageText } from '../client.mjs';
import { ProjectMemory } from '../memory-store.mjs';

const { values } = parseArgs({ options: { 'core-url': { type: 'string' }, directory: { type: 'string' }, state: { type: 'string' } }, strict: true });
if (!values['core-url'] || !values.directory || !path.isAbsolute(values.directory) || (values.state && !path.isAbsolute(values.state))) throw new Error('Usage: node agent/tools/verify-adapters.mjs --core-url http://127.0.0.1:PORT --directory ABS_SYNTHETIC_DIRECTORY [--state ABS_EVIDENCE_JSON]');
const directory = values.directory;
const connections = new Set();
const run = path.join(directory, `run-${randomUUID()}`);
const workspace = path.join(run, 'workspace');
const state = path.join(run, 'mock-state');
await mkdir(workspace, { recursive: true });
await mkdir(state, { recursive: true });
const headers = { ...(process.env.THOR_CORE_AUTHORIZATION ? { Authorization: process.env.THOR_CORE_AUTHORIZATION } : {}), ...(process.env.THOR_CORE_CSRF ? { 'X-CSRF-Token': process.env.THOR_CORE_CSRF } : {}), ...(process.env.THOR_CORE_LOCAL_TOKEN ? { 'X-Thor-Local-Token': process.env.THOR_CORE_LOCAL_TOKEN } : {}) };
const api = createLocalCoreClient(values['core-url'], { headers });
const fixture = fileURLToPath(new URL('./synthetic-acp.mjs', import.meta.url));
const stale = (await api.get('/api/agents/management')).data.filter(agent => agent.agent_source === 'custom' && agent.name.startsWith('Thor Synthetic ACP run-') && agent.args[0] === fixture);
const staleIds = new Set(stale.map(agent => agent.id));
for (const conversation of (await api.get('/api/conversations?limit=100')).data.items) {
  if (staleIds.has(conversation.extra.agent_id)) await api.delete(`/api/conversations/${encodeURIComponent(conversation.id)}`);
}
for (const agent of stale) await api.delete(`/api/agents/custom/${encodeURIComponent(agent.id)}`);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseline = (await api.get('/api/conversations?limit=100')).data.items.filter(item => item.extra.backend === 'codex');
const original = await Promise.all(baseline.map(async conversation => ({ id: conversation.id, messages: fingerprint((await api.get(`/api/conversations/${encodeURIComponent(conversation.id)}/messages?limit=100`)).data.items) })));
const ownConversations = new Set();
const events = [];
let socket;
const connect = async () => {
  const url = new URL('/ws', values['core-url']);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocketTransport(url, { headers: { ...headers, Origin: new URL(values['core-url']).origin } });
  connections.add(socket);
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (ownConversations.has(frame.data?.conversation_id)) events.push(frame);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, label, timeout = 30000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await predicate(); if (value) return value; await pause(75); }
  throw new Error(`Timed out: ${label}`);
};
const registration = { name: `Thor Synthetic ACP ${path.basename(run)}`, command: process.execPath, args: [fixture], env: [{ name: 'THOR_MOCK_STATE_DIR', value: state }], advanced: { description: 'Invented ACP v1 acceptance fixture. No model, enterprise access or external tool execution.' } };
const result = { synthetic: true, actualDesktopUiTested: false, modifiedDesktopOrHost: false, independentHeadlessClient: true };
let conversationId;
try {
  await connect();
  const probe = (await api.post('/api/agents/custom/try-connect', { command: registration.command, acp_args: registration.args, env: { THOR_MOCK_STATE_DIR: state } })).data;
  assert.equal(probe.step, 'success');
  const agent = (await api.post('/api/agents/custom', registration)).data;
  assert.ok(agent.id);
  await api.post(`/api/agents/${encodeURIComponent(agent.id)}/health-check`);
  const assistant = (await api.get('/api/assistants')).data.find(item => item.agent_id === agent.id);
  assert.ok(assistant, 'Registered custom agent not exposed through the normal assistant catalog.');
  const created = (await api.post('/api/conversations', { name: 'Thor ACP adapter acceptance', assistant: { id: assistant.id, locale: 'en-US', conversation_overrides: { mcp_ids: [] } }, extra: { workspace, custom_workspace: true, selected_mcp_server_ids: [], selected_session_mcp_servers: [] } })).data;
  conversationId = created.id;
  ownConversations.add(conversationId);
  const route = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const messages = async () => (await api.get(`${route}/messages?limit=100`)).data.items;
  const turn = async content => {
    const sent = (await api.post(`${route}/messages`, { content })).data;
    await waitForCoreIdle(api, conversationId, { timeoutMs: 30000, pollMs: 100 });
    return { sent, messages: await messages() };
  };
  const initial = await turn('THOR_STREAM_DIAGNOSTIC');
  assert.ok(initial.messages.some(message => messageText(message).includes('THOR_STREAM_FIRST')));
  await wait(() => events.some(event => event.name === 'message.stream' && event.data.type === 'content' && JSON.stringify(event.data.data).includes('THOR_STREAM_SECOND')), 'streamed second chunk');
  result.startAndStreaming = true;

  const approval = (await api.post(`${route}/messages`, { content: 'THOR_APPROVAL_DIAGNOSTIC' })).data;
  await wait(() => events.some(event => event.name === 'message.stream' && event.data.type === 'acp_permission'), 'permission event');
  socket.terminate();
  const confirmations = (await api.get(`${route}/confirmations`)).data;
  assert.equal(confirmations.length, 1);
  assert.ok(confirmations[0].options.some(option => option.value === 'allow_once'));
  await connect();
  await api.post(`${route}/confirmations/${encodeURIComponent(confirmations[0].call_id)}/confirm`, { msg_id: approval.msg_id, data: { option_id: 'allow_once' }, always_allow: false });
  await waitForCoreIdle(api, conversationId, { timeoutMs: 30000, pollMs: 100 });
  assert.ok((await messages()).some(message => messageText(message).includes('THOR_APPROVAL_ACCEPTED')));
  result.permissionRoundTrip = true;
  result.reconnectAndPendingApprovalRecovery = true;

  const cancelled = (await api.post(`${route}/messages`, { content: 'THOR_CANCEL_DIAGNOSTIC' })).data;
  await wait(() => events.some(event => event.name === 'message.stream' && event.data.turn_id === cancelled.turn_id && event.data.type === 'content' && JSON.stringify(event.data.data).includes('THOR_CANCEL_WAITING')), 'cancel pending text');
  await api.post(`${route}/cancel`, { turn_id: cancelled.turn_id });
  await waitForCoreIdle(api, conversationId, { timeoutMs: 30000, pollMs: 100 });
  await turn('THOR_STREAM_AFTER_CANCEL_DIAGNOSTIC');
  result.cancelThenSuccessfulTurn = true;

  const beforeRestart = await messages();
  const restarted = (await api.post(`${route}/runtime/restart`)).data;
  assert.ok(restarted.runtime.has_task);
  const resumed = await turn('THOR_RESUME_DIAGNOSTIC');
  assert.ok(resumed.messages.some(message => /THOR_RESUME_OK fact=THOR_SYNTHETIC_FACT_8472 loads=[1-9]/.test(messageText(message))));
  assert.ok(beforeRestart.every(message => resumed.messages.some(saved => saved.id === message.id)));
  result.runtimeRestartLoadsOriginalSession = true;
  result.historyPreserved = true;

  const detail = (await api.get(route)).data;
  assert.ok(detail.project_id);
  const project = (await api.get(`/api/projects/${encodeURIComponent(detail.project_id)}`)).data;
  assert.equal(project.project_id, detail.project_id);
  const memory = new ProjectMemory(workspace);
  await memory.save({ id: 'p05-synthetic-fact', title: 'Synthetic headless boundary fact', source: 'Explicit synthetic acceptance instruction', origin: 'user', mode: 'explicit', content: 'THOR_HEADLESS_MEMORY_5948' });
  const content = (await api.post('/api/fs/content', { file: { kind: 'project', pe_id: project.explorer.workspace_pe_id, relative_path: 'THOR_MEMORY.md' }, encoding: 'utf8' })).data;
  assert.ok(content.includes('THOR_HEADLESS_MEMORY_5948'));
  socket.terminate();
  await connect();
  assert.equal((await api.get(route)).data.project_id, detail.project_id);
  assert.ok((await messages()).some(message => messageText(message).includes('THOR_RESUME_OK')));
  result.sameProjectResultAndMemoryRead = true;
  result.projectId = detail.project_id;
  result.agentId = agent.id;
  result.conversationId = conversationId;

  for (const previous of original) assert.equal(fingerprint((await api.get(`/api/conversations/${encodeURIComponent(previous.id)}/messages?limit=100`)).data.items), previous.messages, 'A pre-existing native Codex history changed.');
  result.preExistingCodexConversationsUntouched = original.length;
  const methodLog = (await readFile(path.join(state, 'methods.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const method of ['initialize', 'session/new', 'session/prompt', 'session/cancel', 'session/load']) assert.ok(methodLog.some(entry => entry.method === method), `Missing wire method ${method}`);
  result.wireMethods = [...new Set(methodLog.map(entry => entry.method))];
  result.eventNames = [...new Set(events.map(event => event.name))];
  result.streamTypes = [...new Set(events.filter(event => event.name === 'message.stream').map(event => event.data.type))];
  result.passed = true;
} finally {
  for (const connection of connections) connection.terminate();
  result.eventNames = [...new Set(events.map(event => event.name))];
  result.streamTypes = [...new Set(events.filter(event => event.name === 'message.stream').map(event => event.data.type))];
  await writeFile(values.state || path.join(directory, 'latest-evidence.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result));
