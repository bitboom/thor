// Synthetic ACP v1 responder. Schema: agent-client-protocol-schema 1.5.0 v1.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const stateRoot = process.env.THOR_MOCK_STATE_DIR;
if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error('Explicit synthetic state directory required.');
mkdirSync(stateRoot, { recursive: true });
const log = (method, sessionId = null) => appendFileSync(path.join(stateRoot, 'methods.jsonl'), JSON.stringify({ method, sessionId }) + '\n');
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const result = (id, value) => send({ id, result: value });
const pendingPermissions = new Map();
const pendingPrompts = new Map();
const stateFile = id => {
  if (!/^thor-mock-[a-f0-9-]+$/.test(id)) throw new Error('Invalid synthetic session id.');
  return path.join(stateRoot, `${id}.json`);
};
const load = id => JSON.parse(readFileSync(stateFile(id), 'utf8'));
const save = value => writeFileSync(stateFile(value.id), JSON.stringify(value));
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const text = (id, value) => update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function handle(frame) {
  if (!frame.method) {
    const resolve = pendingPermissions.get(frame.id);
    if (resolve) { pendingPermissions.delete(frame.id); resolve(frame.result); }
    return;
  }
  const params = frame.params || {};
  log(frame.method, params.sessionId || null);
  if (frame.method === 'initialize') {
    return result(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} }, authMethods: [], agentInfo: { name: 'Thor synthetic ACP fixture', version: '0.1.0' } });
  }
  if (frame.method === 'session/new') {
    const id = `thor-mock-${randomUUID()}`;
    save({ id, turns: 0, loads: 0, fact: 'THOR_SYNTHETIC_FACT_8472' });
    return result(frame.id, { sessionId: id });
  }
  if (frame.method === 'session/load') {
    if (!existsSync(stateFile(params.sessionId))) return send({ id: frame.id, error: { code: -32000, message: 'Synthetic session not found' } });
    const state = load(params.sessionId);
    state.loads += 1; save(state);
    return result(frame.id, {});
  }
  if (frame.method === 'session/cancel') {
    const prompt = pendingPrompts.get(params.sessionId);
    if (prompt) {
      pendingPrompts.delete(params.sessionId);
      prompt.cancelled = true;
      result(prompt.id, { stopReason: 'cancelled' });
    }
    for (const [id, resolve] of pendingPermissions) { pendingPermissions.delete(id); resolve({ outcome: { outcome: 'cancelled' } }); }
    return;
  }
  if (frame.method === 'session/prompt') {
    const state = load(params.sessionId);
    state.turns += 1; save(state);
    const prompt = { id: frame.id, cancelled: false };
    pendingPrompts.set(params.sessionId, prompt);
    const input = params.prompt.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (input.includes('THOR_CANCEL_DIAGNOSTIC')) {
      text(state.id, 'THOR_CANCEL_WAITING');
      return;
    }
    if (input.includes('THOR_APPROVAL_DIAGNOSTIC')) {
      const toolCallId = `thor-tool-${randomUUID()}`;
      update(state.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Read an invented synthetic note', kind: 'read', status: 'pending', rawInput: { description: 'Synthetic approval fixture; no external file or service is read.' } });
      const permissionId = `thor-permission-${randomUUID()}`;
      const response = new Promise(resolve => pendingPermissions.set(permissionId, resolve));
      send({ id: permissionId, method: 'session/request_permission', params: { sessionId: state.id, toolCall: { toolCallId, title: 'Read an invented synthetic note', kind: 'read', status: 'pending' }, options: [{ optionId: 'allow_once', name: 'Allow synthetic read once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject synthetic read', kind: 'reject_once' }] } });
      const decision = await response;
      if (prompt.cancelled) return;
      const selected = decision?.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow_once';
      update(state.id, { sessionUpdate: 'tool_call_update', toolCallId, status: selected ? 'completed' : 'failed', rawOutput: { synthetic: true, selected } });
      text(state.id, selected ? 'THOR_APPROVAL_ACCEPTED' : 'THOR_APPROVAL_REJECTED');
    } else if (input.includes('THOR_RESUME_DIAGNOSTIC')) {
      text(state.id, `THOR_RESUME_OK fact=${state.fact} loads=${state.loads} turns=${state.turns}`);
    } else {
      text(state.id, 'THOR_STREAM_FIRST ');
      await pause(120);
      if (prompt.cancelled) return;
      text(state.id, 'THOR_STREAM_SECOND');
    }
    pendingPrompts.delete(state.id);
    return result(frame.id, { stopReason: 'end_turn' });
  }
  if (frame.id !== undefined) send({ id: frame.id, error: { code: -32601, message: 'Synthetic fixture does not support this capability' } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let frame;
  try { frame = JSON.parse(line); }
  catch { return send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
  void handle(frame).catch(() => { if (frame.id !== undefined) send({ id: frame.id, error: { code: -32603, message: 'Synthetic fixture failed' } }); });
});
