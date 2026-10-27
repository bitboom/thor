// Evidence helpers for the native Codex memory acceptance command.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativePowerShellCommand } from './native-command-evidence.mjs';

const valueOf = row => typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b)
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export const memoryDigest = value => createHash('sha256').update(value).digest('hex');

// Bounded evidence grammar, not a shell interpreter. Unknown wrappers, loops,
// pipelines, variable substitution and comments cannot prove CLI execution.
function statements(command) {
  const result = []; let words = [], text = '', started = false, quote = null;
  const word = () => { if (started) words.push(text); text = ''; started = false; };
  const statement = () => { word(); if (words.length) result.push(words); words = []; };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === '$' || character === '`') return [];
      if (character === quote) {
        if (quote === "'" && command[index + 1] === "'") { text += "'"; index++; }
        else quote = null;
      } else text += character;
    } else if (character === '"' || character === "'") { if (started) return []; started = true; quote = character; }
    else if (character === ';' || character === '\r' || character === '\n') statement();
    else if (/\s/.test(character)) word();
    else if (character === '&') { word(); words.push('&'); }
    else if (/[|#`$(){}<>]/.test(character)) return [];
    else { started = true; text += character; }
  }
  if (quote) return [];
  statement(); return result;
}

function invocations(command, { node, cli, workspace }) {
  const parts = statements(command);
  if (!parts.length) return [];
  const result = [];
  for (const words of parts) {
    if (words[0] !== '&' || !samePath(words[1], node) || !samePath(words[2], cli) || (words.length - 3) % 2) return [];
    const args = {};
    for (let index = 3; index < words.length; index += 2) {
      const key = words[index].replace(/^--/, '');
      if (!words[index].startsWith('--') || !['workspace', 'action', 'id', 'title', 'source', 'origin', 'mode', 'content'].includes(key) || key in args) return [];
      args[key] = words[index + 1];
    }
    if (!samePath(args.workspace, workspace) || !['save', 'read', 'list', 'delete'].includes(args.action)) return [];
    result.push(args);
  }
  return result;
}

export function assertEntries(entries, expected, deleted = []) {
  assert.equal(entries.length, expected.length);
  assert.deepEqual(entries.map(entry => entry.id).sort(), expected.map(entry => entry.id).sort());
  for (const wanted of expected) {
    const actual = entries.find(entry => entry.id === wanted.id);
    for (const field of ['title', 'source', 'origin', 'mode', 'content']) assert.equal(actual[field], wanted[field]);
    assert.ok(Number.isFinite(Date.parse(actual.updatedAt)));
  }
  for (const id of deleted) assert.ok(!entries.some(entry => entry.id === id));
}

export function assertRecall(text, entries, deleted) {
  const raw = text.trim().replace(/^```json\s*([\s\S]*?)\s*```$/, '$1');
  const reply = JSON.parse(raw);
  assert.deepEqual(reply, { facts: Object.fromEntries(entries.map(entry => [entry.id, entry.content])), missing: [...deleted].sort() });
}

export function metadata(entries) { return entries.map(({ content, ...entry }) => entry); }

// runCoreTurn returns API-ordered rows created after its pre-send ID snapshot.
// Earlier progress is allowed; an earlier success must never replace a wrong
// terminal answer, an unsettled receipt or a different turn's output.
export function terminalAssistantText(turn) {
  const rows = turn.messages;
  assert.ok(Array.isArray(rows) && rows.length >= 2);
  assert.ok(typeof turn.turnId === 'string' && turn.turnId.trim());
  assert.equal(rows[0].position, 'right');
  assert.equal(valueOf(rows[0])?.thor_turn_intent?.turn_id, turn.turnId);
  assert.equal(valueOf(rows[0])?.thor_turn_intent?.state, 'settled');
  assert.equal(rows.filter(row => row.position === 'right').length, 1);
  assert.ok(rows.every(row => row.status !== 'error'));
  const last = rows.at(-1);
  assert.equal(last.type, 'text'); assert.equal(last.position, 'left'); assert.equal(last.status, 'finish');
  assert.ok(typeof last.id === 'string' && last.id && last.id !== rows[0].id);
  assert.ok(typeof last.backend_turn_id === 'string' && last.backend_turn_id);
  const text = valueOf(last)?.content;
  assert.ok(typeof text === 'string' && text.trim());
  return text;
}

export function recallQuestionBatches(entries) {
  assert.equal(entries.length, 15, 'Recall questions must cover all fifteen retained facts.');
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  return [entries.slice(0, 8), entries.slice(8)];
}

export function assertRecallQuestionCounts(restarts, questions, durableTurns) {
  assert.ok(Number.isInteger(restarts) && restarts >= 1 && restarts <= 5);
  assert.equal(questions, restarts * 2, 'Both fresh recall questions must complete at every restart.');
  assert.equal(durableTurns, 3 + questions, 'Every setup and recall turn must pass closed-Core SQLite verification.');
}

export function verifyMemoryToolCalls(rows, context, requirements, turnId) {
  assert.ok(typeof turnId === 'string' && turnId.trim());
  assert.ok(rows.every(row => row.status !== 'error'), 'Turn contains a persisted error.');
  assert.ok(rows.some(row => row.position === 'right' && valueOf(row)?.thor_turn_intent?.turn_id === turnId
    && valueOf(row)?.thor_turn_intent?.state === 'settled'), 'Current memory turn must be durably settled.');
  const operations = [], ids = new Set();
  for (const row of rows.filter(row => ['tool_call', 'acp_tool_call', 'tool_group'].includes(row.type))) {
    assert.equal(row.type, 'tool_call'); assert.equal(row.status, 'finish');
    const value = valueOf(row); assert.equal(value.status, 'completed');
    assert.ok(typeof value.call_id === 'string' && value.call_id.trim() && !ids.has(value.call_id));
    assert.equal(row.id, value.call_id); ids.add(value.call_id);
    const input = value.input ?? value.args;
    if (input?.type !== 'commandExecution' || typeof input.command !== 'string') continue;
    const command = nativePowerShellCommand(input, context.commandShell);
    if (command === null) continue;
    const calls = invocations(command, context);
    if (!calls.length || typeof value.output !== 'string' || value.output.length > 1024 * 1024) continue;
    let outputs;
    try { outputs = value.output.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { continue; }
    if (outputs.length !== calls.length || outputs.some(output => !output || typeof output !== 'object' || Array.isArray(output) || output.error != null)) continue;
    calls.forEach((args, index) => operations.push({ args, output: outputs[index], callId: value.call_id }));
  }
  const used = new Set();
  for (const requirement of requirements) {
    const match = operations.find(operation => {
      if (!Object.entries(requirement.args).every(([key, value]) => operation.args[key] === value)) return false;
      try { assert.deepEqual(operation.output, requirement.output); return true; } catch { return false; }
    });
    assert.ok(match, 'Required successful bundled memory CLI operation was not persisted.');
    used.add(match.callId);
  }
  return { requiredOperationsVerified: requirements.length, nativeCallsUsed: used.size,
    nativeCallIdsSha256: memoryDigest([...used].sort().join('\n')) };
}

export function assertMayStart(child) { assert.equal(child, undefined, 'Refuse to replace an owned Core whose cleanup is unproven.'); }
export async function stopMemoryCore(child, terminate, delay) {
  if (!child) return;
  assert.ok(child.pid && child.exitCode === null && child.signalCode === null, 'Owned Core exited unexpectedly; descendant cleanup is unproven.');
  const exited = new Promise(resolve => child.once('exit', resolve));
  await terminate(child);
  await Promise.race([exited, delay(5000)]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned Core did not stop.');
}
