#!/usr/bin/env node
// Real Core/Codex acceptance. It owns only the child process it launches.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { ProjectMemory } from '../memory-store.mjs';
import { createLocalCoreClient } from '../adapters/aioncore.mjs';
import { runCoreTurn } from '../client.mjs';

const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const { values } = parseArgs({ options: { core: { type: 'string' }, codex: { type: 'string' }, bundle: { type: 'string' }, 'state-root': { type: 'string' }, restarts: { type: 'string', default: '5' } }, strict: true });
let child;

async function stop() {
  if (!child || child.exitCode !== null) return;
  const processToStop = child;
  const exited = new Promise(resolve => processToStop.once('exit', resolve));
  if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  else processToStop.kill('SIGTERM');
  await Promise.race([exited, pause(5000)]);
  if (processToStop.exitCode === null) throw new Error('Owned Core process did not stop.');
  child = undefined;
}

try {
  for (const name of ['core', 'codex', 'bundle', 'state-root']) assert.ok(values[name] && path.isAbsolute(values[name]), `${name} must be an absolute path.`);
  const restarts = Number(values.restarts);
  assert.ok(Number.isInteger(restarts) && restarts >= 1 && restarts <= 5, 'restarts must be from 1 to 5.');
  const root = values['state-root'];
  const workspace = path.join(root, 'workspace');
  const data = path.join(root, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(data, { recursive: true });
  const memory = new ProjectMemory(workspace);
  assert.equal((await memory.list()).length, 0, 'Use a new synthetic acceptance workspace.');
  const manifest = JSON.parse(await readFile(path.join(values.bundle, 'managed-resources', 'manifest.json'), 'utf8'));
  const nodeDir = path.join(values.bundle, 'managed-resources', manifest.node.root);
  const start = async () => {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const localToken = randomBytes(32).toString('hex');
    child = spawn(values.core, ['--local', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data, '--work-dir', workspace, '--parent-pid', String(process.pid), '--log-level', 'error'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, THOR_CORE_LOCAL_TOKEN: localToken, AIONUI_BUNDLED_MANAGED_RESOURCES: path.join(values.bundle, 'managed-resources'), CODEX_SQLITE_HOME: path.join(root, 'codex-sqlite'), PATH: [path.dirname(values.codex), nodeDir, process.env.PATH ?? ''].join(path.delimiter) },
    });
    let startFailed = false;
    child.on('error', () => { startFailed = true; });
    const api = createLocalCoreClient(`http://127.0.0.1:${port}`, { headers: { 'X-Thor-Local-Token': localToken } });
    for (let index = 0; index < 100; index++) {
      if (startFailed || child.exitCode !== null) throw new Error('Core could not start for memory acceptance.');
      try { await api.get('/api/conversations?limit=1'); return api; } catch { await pause(100); }
    }
    throw new Error('Core did not become ready for memory acceptance.');
  };
  const createConversation = async api => (await api.post('/api/conversations', { type: 'acp', name: 'Thor synthetic memory acceptance', extra: { backend: 'codex', workspace, mcp_server_ids: [] } })).data.id;
  const nonce = randomUUID().replaceAll('-', '');
  const facts = Array.from({ length: 20 }, (_, index) => ({ id: `fact-${index}`, title: `Synthetic project preference ${index}`, source: 'Explicit synthetic acceptance user request', content: `Synthetic remembered value ${nonce}-${index}.` }));
  let api = await start();
  let conversationId = await createConversation(api);
  const initial = await runCoreTurn(api, { conversationId, timeoutMs: 180000, content: `This is an explicit user request to save project memory. Use the bundled memory CLI described in your Thor project-memory policy to save exactly these twenty synthetic entries. Do not directly edit the Markdown or use another directory. Entries: ${JSON.stringify(facts)}. After all saves succeed, reply THOR_MEMORY_SAVED_20.` });
  assert.ok(initial.assistantText.includes('THOR_MEMORY_SAVED_20'), 'Agent did not confirm twenty saves.');
  assert.equal((await memory.list()).length, 20);
  for (const fact of facts) assert.equal((await memory.get(fact.id)).content, fact.content);
  assert.ok(initial.messages.some(message => ['acp_tool_call', 'tool_call', 'tool_group'].includes(message.type) && /memory\.mjs/.test(JSON.stringify(message.content))), 'No actual memory CLI tool invocation was persisted.');
  const updated = facts.slice(0, 5).map(fact => ({ ...fact, content: `Updated ${fact.content}`, source: 'Explicit synthetic update user request' }));
  const deleted = facts.slice(5, 10).map(fact => fact.id);
  await runCoreTurn(api, { conversationId, timeoutMs: 180000, content: `Explicit user request: use the project-memory CLI to update these five entries ${JSON.stringify(updated)}, and delete these five IDs ${JSON.stringify(deleted)}. Preserve every other entry. Reply THOR_MEMORY_EDITED after success.` });
  assert.equal((await memory.list()).length, 15);
  for (const fact of updated) assert.equal((await memory.get(fact.id)).content, fact.content);
  for (const memoryId of deleted) await assert.rejects(memory.get(memoryId), { code: 'NOT_FOUND' });
  process.stdout.write(`${JSON.stringify({ phase: 'write-update-delete', passed: true, saved: 20, updated: 5, deleted: 5 })}\n`);
  for (let restart = 1; restart <= restarts; restart++) {
    await stop();
    api = await start();
    // Fresh conversation prevents its transcript from supplying the values.
    conversationId = await createConversation(api);
    const recalled = await runCoreTurn(api, { conversationId, timeoutMs: 180000, content: 'Use the Thor project-memory CLI from your policy to read the ten saved facts fact-10 through fact-19. Return each exact saved value with its ID. Do not invent values, use a prior conversation, or change the file.' });
    for (const fact of facts.slice(10)) assert.ok(recalled.assistantText.includes(fact.content), `Memory recall failed for ${fact.id}.`);
    assert.equal((await memory.list()).length, 15);
    process.stdout.write(`${JSON.stringify({ phase: 'fresh-session-recall', restart, passed: true, recalled: 10, retained: 15 })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ passed: true, realCore: true, realCodex: true, nativeMemoryPolicy: true, saved: 20, updated: 5, deleted: 5, restarts, freshConversationRecallPerRestart: 10 })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally { await stop().catch(() => { process.exitCode = 1; }); }
