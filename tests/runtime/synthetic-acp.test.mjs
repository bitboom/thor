import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../../agent/tools/synthetic-acp.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(state) {
  const child = spawn(process.execPath, [fixture], { env: { ...process.env, THOR_MOCK_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let sequence = 0;
  const requests = new Map();
  const incoming = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line);
    incoming.push(frame);
    if (!frame.method && requests.has(frame.id)) { requests.get(frame.id)(frame); requests.delete(frame.id); }
  });
  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const request = (method, params = {}) => {
    const id = ++sequence;
    const response = new Promise(resolve => requests.set(id, resolve));
    send({ id, method, params });
    return response;
  };
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const value = incoming.find(predicate); if (value) return value; await pause(10); }
    throw new Error('Synthetic ACP frame did not arrive.');
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    const finished = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await finished;
  };
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.result.protocolVersion, 1);
  return { request, send, incoming, until, close, initialized };
}

async function directory(t) {
  const state = await mkdtemp(path.join(tmpdir(), 'thor-synthetic-acp-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  return state;
}

test('synthetic ACP initialization, session creation and multiple streamed chunks use real stdio', { timeout: 10000 }, async t => {
  const client = await start(await directory(t));
  t.after(client.close);
  assert.equal(client.initialized.result.agentCapabilities.loadSession, true);
  const { result: { sessionId } } = await client.request('session/new', { cwd: tmpdir(), mcpServers: [] });
  const reply = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THOR_STREAM_DIAGNOSTIC' }] });
  assert.equal(reply.result.stopReason, 'end_turn');
  assert.deepEqual(client.incoming.filter(frame => frame.method === 'session/update').map(frame => frame.params.update.content.text), ['THOR_STREAM_FIRST ', 'THOR_STREAM_SECOND']);
  const unsupported = await client.request('thor/unsupported');
  assert.equal(unsupported.error.code, -32601);
});

test('synthetic ACP permission selection and cancellation complete only their pending turn', { timeout: 10000 }, async t => {
  const client = await start(await directory(t));
  t.after(client.close);
  const { result: { sessionId } } = await client.request('session/new', { cwd: tmpdir(), mcpServers: [] });
  const approval = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THOR_APPROVAL_DIAGNOSTIC' }] });
  const permission = await client.until(frame => frame.method === 'session/request_permission');
  assert.deepEqual(permission.params.options.map(option => option.optionId), ['allow_once', 'reject_once']);
  client.send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  assert.equal((await approval).result.stopReason, 'end_turn');
  assert.ok(client.incoming.some(frame => frame.method === 'session/update' && frame.params.update.content?.text === 'THOR_APPROVAL_ACCEPTED'));
  const cancellation = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THOR_CANCEL_DIAGNOSTIC' }] });
  await client.until(frame => frame.params?.update?.content?.text === 'THOR_CANCEL_WAITING');
  client.send({ method: 'session/cancel', params: { sessionId } });
  assert.equal((await cancellation).result.stopReason, 'cancelled');
  assert.equal((await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THOR_STREAM_AFTER_CANCEL' }] })).result.stopReason, 'end_turn');
});

test('synthetic ACP session/load restores its original fact across separate agent processes', { timeout: 10000 }, async t => {
  const state = await directory(t);
  const first = await start(state);
  const { result: { sessionId } } = await first.request('session/new', { cwd: tmpdir(), mcpServers: [] });
  await first.close();
  const second = await start(state);
  t.after(second.close);
  assert.deepEqual((await second.request('session/load', { sessionId, cwd: tmpdir(), mcpServers: [] })).result, {});
  await second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THOR_RESUME_DIAGNOSTIC' }] });
  const resumed = await second.until(frame => frame.params?.update?.content?.text?.includes('THOR_RESUME_OK'));
  assert.match(resumed.params.update.content.text, /fact=THOR_SYNTHETIC_FACT_8472 loads=1/);
});
