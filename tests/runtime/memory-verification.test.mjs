import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMemoryAcceptance } from '../../agent/tools/verify-memory.mjs';
import { assertEntries, assertRecall, metadata, verifyMemoryToolCalls, assertMayStart, stopMemoryCore, terminalAssistantText, recallQuestionBatches, assertRecallQuestionCounts } from '../../agent/tools/memory-verification.mjs';
import { displayQuote, observedSegmentedQuote } from '../../agent/tools/native-command-evidence.mjs';

const workspace = path.resolve('synthetic project & [A]'), node = path.resolve('synthetic bundle/node.exe'), cli = path.resolve('synthetic bundle/tools/memory.mjs');
const context = { workspace, node, cli }, turnId = 'synthetic-turn';
const entry = { id: 'fact-0', title: 'Synthetic preference', source: 'Synthetic user statement', origin: 'user', mode: 'explicit', content: 'Synthetic value', updatedAt: '2030-01-01T00:00:00Z' };
const args = { workspace, action: 'save', id: entry.id, title: entry.title, source: entry.source, origin: 'user', mode: 'explicit', content: entry.content };
const output = { saved: true, updated: false, id: 'fact-0', file: 'THOR_MEMORY.md' };
const command = (values = args) => `& '${node}' '${cli}' ${Object.entries(values).map(([key, value]) => `--${key} '${value}'`).join(' ')}`;
const rows = (body = command(), result = output) => [
  { type: 'text', position: 'right', status: 'finish', content: { thor_turn_intent: { turn_id: turnId, state: 'settled' } } },
  { id: 'call-1', type: 'tool_call', status: 'finish', content: { call_id: 'call-1', status: 'completed', input: { type: 'commandExecution', cwd: workspace, command: body }, output: JSON.stringify(result) } },
];
const requirements = [{ args: { action: 'save', id: 'fact-0', content: 'Synthetic value' }, output }];

test('native memory evidence binds exact bundled executable, CLI, workspace, arguments and successful output', () => {
  const proof = verifyMemoryToolCalls(rows(), context, requirements, turnId);
  assert.equal(proof.requiredOperationsVerified, 1); assert.equal(proof.nativeCallsUsed, 1);
  assert.deepEqual(verifyMemoryToolCalls(rows().map(row => ({ ...row, content: JSON.stringify(row.content) })), context, requirements, turnId), proof);
  for (const value of [rows(command({ ...args, workspace: path.resolve('different project') })), rows(command().replace(cli, path.resolve('different memory.mjs'))),
    rows(command(), { error: { code: 'IO_ERROR' } }), rows(command(), { ...output, id: 'different' }), rows(`Write-Output '${JSON.stringify(output)}'`),
    rows(`${command()}; Write-Output '${JSON.stringify(output)}'`), rows(`if ($false) { ${command()} }`)]) {
    assert.throws(() => verifyMemoryToolCalls(value, context, requirements, turnId));
  }
});

test('command-batch JSON outputs must correspond to each direct invocation', () => {
  const batch = rows(`${command()}; ${command({ workspace, action: 'delete', id: 'fact-1' })}`);
  batch[1].content.output = JSON.stringify(output) + '\n' + JSON.stringify({ deleted: true, id: 'fact-1', file: 'THOR_MEMORY.md' });
  assert.equal(verifyMemoryToolCalls(batch, context, [...requirements, { args: { action: 'delete', id: 'fact-1' }, output: { deleted: true, id: 'fact-1', file: 'THOR_MEMORY.md' } }], turnId).requiredOperationsVerified, 2);
  batch[1].content.output = JSON.stringify(output);
  assert.throws(() => verifyMemoryToolCalls(batch, context, requirements, turnId));
});

test('wrapped native evidence needs the explicit matching shell and retains all literal/output/error gates', () => {
  const shell = String.raw`C:\Synthetic Tools\PowerShell\pwsh.exe`;
  for (const quote of [displayQuote, observedSegmentedQuote]) {
    const value = rows();
    value[1].content.input = { type: 'commandExecution', source: 'unifiedExecStartup', pluginId: null, scriptPath: null,
      command: `${displayQuote(shell)} -Command ${quote(command())}`, commandActions: [{ type: 'unknown', command: command() }] };
    assert.equal(verifyMemoryToolCalls(value, { ...context, commandShell: shell }, requirements, turnId).nativeCallsUsed, 1);
    assert.throws(() => verifyMemoryToolCalls(value, context, requirements, turnId));
    assert.throws(() => verifyMemoryToolCalls(value, { ...context, commandShell: String.raw`C:\Other\pwsh.exe` }, requirements, turnId));
    for (const mutate of [v => { v[1].content.output = JSON.stringify({ error: { code: 'FAILED' } }); },
      v => { v[1].content.input.command += '; extra'; }, v => { v[1].content.status = 'canceled'; },
      v => { v[1].content.input.commandActions[0].command += '; Write-Output ok'; }]) {
      const bad = structuredClone(value); mutate(bad);
      assert.throws(() => verifyMemoryToolCalls(bad, { ...context, commandShell: shell }, requirements, turnId));
    }
  }
});

test('recall uses the current settled terminal answer and never scans backward past wrong/stale/error rows', () => {
  const user = { id: 'user', type: 'text', status: 'finish', position: 'right', content: { thor_turn_intent: { turn_id: turnId, state: 'settled' } } };
  const reply = JSON.stringify({ facts: { [entry.id]: entry.content }, missing: ['fact-5'] });
  const answer = { id: 'answer', type: 'text', status: 'finish', position: 'left', backend_turn_id: 'native-current', content: { content: reply } };
  const progress = { ...answer, id: 'progress', content: { content: 'Checking current facts.' } };
  const turn = messages => ({ turnId, messages });
  assert.doesNotThrow(() => assertRecall(terminalAssistantText(turn([user, progress, answer])), [entry], ['fact-5']));
  const wrong = { ...answer, id: 'wrong', content: { content: JSON.stringify({ facts: {}, missing: [] }) } };
  assert.throws(() => assertRecall(terminalAssistantText(turn([user, answer, wrong])), [entry], ['fact-5']));
  for (const last of [{ ...answer, type: 'tool_call' }, { ...answer, status: 'error' }, { ...answer, status: 'pending' },
    { ...answer, position: 'right' }, { ...answer, backend_turn_id: null }, { ...answer, content: {} }]) {
    assert.throws(() => terminalAssistantText(turn([user, answer, last])));
  }
  assert.throws(() => terminalAssistantText(turn([answer, user])));
  assert.throws(() => terminalAssistantText(turn([answer])));
  assert.throws(() => terminalAssistantText({ turnId: 'other', messages: [user, answer] }));
  assert.throws(() => terminalAssistantText(turn([user, { ...user, id: 'second-user' }, answer])));
});

test('two recall batches cover all fifteen current facts and the durable-count gate rejects incomplete or extra turns', () => {
  const entries = [...Array.from({ length: 5 }, (_, i) => ({ id: `fact-${i}` })), ...Array.from({ length: 10 }, (_, i) => ({ id: `fact-${i + 10}` }))];
  const batches = recallQuestionBatches(entries);
  assert.deepEqual(batches.map(batch => batch.length), [8, 7]);
  assert.deepEqual(batches.flat().map(item => item.id), entries.map(item => item.id));
  assert.equal(new Set(batches.flat().map(item => item.id)).size, 15);
  assert.throws(() => recallQuestionBatches(entries.slice(1)));
  assert.throws(() => recallQuestionBatches([...entries.slice(1), entries[1]]));
  assert.doesNotThrow(() => assertRecallQuestionCounts(5, 10, 13));
  for (const counts of [[5, 9, 12], [5, 10, 12], [5, 10, 14], [4, 10, 13]]) assert.throws(() => assertRecallQuestionCounts(...counts));
});

test('failed/cancelled/duplicate native calls, unsettled or wrong turn receipt do not establish success', () => {
  for (const mutate of [value => { value[1].status = 'error'; }, value => { value[1].content.status = 'canceled'; },
    value => { value.push(structuredClone(value[1])); }, value => { value[0].content.thor_turn_intent.state = 'pending'; },
    value => { value[0].content.thor_turn_intent.turn_id = 'other'; }, value => { value[1].type = 'tool_group'; }]) {
    const value = rows(); mutate(value); assert.throws(() => verifyMemoryToolCalls(value, context, requirements, turnId));
  }
});

test('updated, deleted and unchanged entries are all checked; fresh recall must contain exact current values and absences', () => {
  const expected = [entry, { ...entry, id: 'fact-10', content: 'Unchanged value' }];
  assert.doesNotThrow(() => assertEntries(expected, expected, ['fact-5']));
  assert.throws(() => assertEntries([{ ...entry, content: 'stale' }, expected[1]], expected, ['fact-5']));
  assert.throws(() => assertEntries([...expected, { ...entry, id: 'fact-5' }], expected, ['fact-5']));
  const reply = { facts: { 'fact-0': entry.content, 'fact-10': 'Unchanged value' }, missing: ['fact-5'] };
  assert.doesNotThrow(() => assertRecall(JSON.stringify(reply), expected, ['fact-5']));
  assert.throws(() => assertRecall(JSON.stringify({ ...reply, missing: [] }), expected, ['fact-5']));
  assert.equal(metadata(expected)[0].content, undefined);
});

test('retained Core reference forbids restart; early exit/failed kill/timeout never become cleanup success', async () => {
  const child = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  assert.doesNotThrow(() => assertMayStart(undefined));
  assert.throws(() => assertMayStart(child())); assert.throws(() => assertMayStart(Object.assign(child(), { exitCode: 0 })));
  let attempts = 0;
  await assert.rejects(stopMemoryCore(Object.assign(child(), { exitCode: 0 }), async () => { attempts++; }, async () => {}));
  assert.equal(attempts, 0);
  await assert.rejects(stopMemoryCore(child(), async () => { throw Error('failed'); }, async () => {}));
  await assert.rejects(stopMemoryCore(child(), async () => {}, async () => {}));
  const owned = child(); await stopMemoryCore(owned, async () => { owned.exitCode = 0; owned.emit('exit'); }, async () => {});
});

test('preflight rejects even empty existing state or existing evidence before opening Core', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'thor-memory-verifier-'));
  assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep));
  try {
    const state = path.join(temporary, 'existing-empty-state'); await mkdir(state);
    const options = { core: path.join(temporary, 'nonexistent-core.exe'), codex: path.join(temporary, 'codex.exe'),
      bundle: temporary, repo: temporary, 'state-root': state, evidence: path.join(temporary, 'new-evidence.json') };
    await assert.rejects(createMemoryAcceptance(options), /Acceptance state\/evidence must not already exist/);
    const evidence = path.join(temporary, 'existing-evidence.json'); await writeFile(evidence, 'preserve');
    await assert.rejects(createMemoryAcceptance({ ...options, 'state-root': path.join(temporary, 'new-state'), evidence }), /Acceptance state\/evidence must not already exist/);
    const newState = path.join(temporary, 'shell-rejected-state');
    await assert.rejects(createMemoryAcceptance({ ...options, 'state-root': newState,
      evidence: path.join(temporary, 'shell-rejected-evidence.json'), 'command-shell': temporary }), /ordinary/);
    await assert.rejects(import('node:fs/promises').then(fs => fs.lstat(newState)), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
