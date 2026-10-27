#!/usr/bin/env node
// Real Core crash acceptance with the existing invented ACP adapter.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createLocalCoreClient } from '../adapters/aioncore.mjs';
import { messageText, runCoreTurn } from '../client.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const referenceSha256 = '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892';
const usage = 'Usage: node agent/tools/verify-recovery.mjs --core ABS_CORE --bundle ABS_CORE_BUNDLE --state-root ABS_SYNTHETIC_STATE [--reference] [--evidence ABS_NEW_JSON]\n';

export function truthfulInterruption(messages, priorRows) {
  const warning = messages.some(row => row.type === 'tips' && row.content?.code === 'THOR_WORK_INTERRUPTED'
    && row.content?.recovery?.remote_outcome === 'unknown' && row.content?.recovery?.automatic_replay === false);
  const preserved = priorRows.every(prior => {
    const saved = messages.find(row => row.id === prior.id);
    if (!saved || !messageText(saved).includes(messageText(prior))) return false;
    if (prior.position === 'right') return saved.content?.thor_turn_intent?.state === 'interrupted';
    return saved.status === 'error' && saved.content?.thor_recovery?.state === 'interrupted';
  });
  return warning && preserved;
}

async function wait(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(50); }
  throw new Error(`Recovery acceptance timed out during ${label}.`);
}

async function port() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const selected = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return selected;
}

export async function verifyRecovery(options) {
  for (const name of ['core', 'bundle', 'state-root']) assert.ok(options[name] && path.isAbsolute(options[name]), `${name} must be absolute.`);
  if (options.evidence) assert.ok(path.isAbsolute(options.evidence));
  const coreSha256 = digest(await readFile(options.core));
  if (options.reference) assert.equal(coreSha256, referenceSha256, 'Reference evidence requires the known upstream Core binary.');
  await mkdir(options['state-root'], { recursive: true });
  const run = await mkdtemp(path.join(options['state-root'], 'recovery-'));
  const workspace = path.join(run, 'workspace');
  const mockState = path.join(run, 'mock-state');
  await mkdir(workspace, { recursive: true }); await mkdir(mockState, { recursive: true });
  const gate = path.join(mockState, 'before-initialize.gate');
  const gateObserved = path.join(mockState, 'gate-observed.json');
  const workspaceFile = path.join(workspace, 'synthetic-recovery-note.txt');
  const workspaceValue = `Thor invented recovery fact ${randomUUID()}`;
  await writeFile(workspaceFile, workspaceValue, { flag: 'wx' });
  let child;
  let phase = 'startup';
  let api;
  let base;
  let expectRejected;
  const evidence = { schemaVersion: 1, synthetic: true, coreSha256, referenceCore: options.reference === true,
    patchedCore: options.reference !== true, realCore: true, realModel: false, installedDesktop: false,
    remoteSideEffectsTested: false, powerLossTested: false, cases: {}, passed: false };
  const kill = async () => {
    if (!child?.pid || child.exitCode !== null) return;
    const owned = child;
    const exited = new Promise(resolve => owned.once('exit', resolve));
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-owned.pid, 'SIGKILL'); } catch { owned.kill('SIGKILL'); } }
    await Promise.race([exited, pause(5000)]);
    assert.ok(owned.exitCode !== null || owned.signalCode !== null, 'Owned Core did not stop.');
    child = undefined;
  };
  const start = async () => {
    const selected = await port();
    const token = randomBytes(32).toString('hex');
    const env = { ...process.env, THOR_CORE_LOCAL_TOKEN: token, AIONUI_BUNDLED_MANAGED_RESOURCES: path.join(options.bundle, 'managed-resources'), CODEX_SQLITE_HOME: path.join(run, 'codex-sqlite') };
    delete env.THOR_CORE_TRUSTED_ORIGIN;
    child = spawn(options.core, ['--local', '--host', '127.0.0.1', '--port', String(selected), '--data-dir', path.join(run, 'data'),
      '--work-dir', workspace, '--parent-pid', String(process.pid), '--managed-resources-mode', 'bundled', '--log-level', 'error'],
    { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore', env });
    let failed = false; child.once('error', () => { failed = true; });
    base = `http://127.0.0.1:${selected}`;
    api = createLocalCoreClient(base, { headers: { 'X-Thor-Local-Token': token } });
    expectRejected = async (route, payload, code, statuses = [409]) => {
      const response = await fetch(new URL(route, base), { method: 'POST', headers: { 'X-Thor-Local-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) });
      assert.ok(statuses.includes(response.status), 'A reserved operation was unexpectedly accepted.');
      if (code) assert.equal((await response.json()).code, code, 'Core returned the wrong reservation error.');
      else await response.arrayBuffer();
    };
    await wait(async () => {
      if (failed || child.exitCode !== null) throw new Error('Core exited before recovery acceptance readiness.');
      try { return (await api.get('/api/conversations?limit=1')).success; } catch { return false; }
    }, 'Core startup', 90000);
  };
  const methods = async () => {
    try { return (await readFile(path.join(mockState, 'methods.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const prompts = async () => (await methods()).filter(entry => entry.method === 'session/prompt').length;
  let route;
  const messages = async () => (await api.get(`${route}/messages?limit=100`)).data.items;
  const snapshot = rows => rows.map(row => ({ id: row.id, type: row.type, status: row.status, content: row.content, hidden: row.hidden }));
  const resume = async () => {
    const turn = await runCoreTurn(api, { conversationId: route.split('/').at(-1), content: 'THOR_RESUME_DIAGNOSTIC', timeoutMs: 30000 });
    assert.match(turn.assistantText, /THOR_RESUME_OK fact=THOR_SYNTHETIC_FACT_8472/);
    return /loads=[1-9]/.test(turn.assistantText);
  };
  const restart = async () => { await kill(); await start(); assert.equal(await readFile(workspaceFile, 'utf8'), workspaceValue); };
  try {
    await start();
    const fixture = fileURLToPath(new URL('./recovery-acp.mjs', import.meta.url));
    const registration = { name: `Thor crash acceptance ${randomUUID()}`, command: process.execPath, args: [fixture], env: [
      { name: 'THOR_MOCK_STATE_DIR', value: mockState }, { name: 'THOR_RECOVERY_GATE_FILE', value: gate }, { name: 'THOR_MOCK_RECOVERY_STREAM', value: '1' }],
      advanced: { description: 'Synthetic ACP crash acceptance only; no enterprise or model access.' } };
    const probe = (await api.post('/api/agents/custom/try-connect', { command: registration.command, acp_args: registration.args,
      env: { THOR_MOCK_STATE_DIR: mockState, THOR_RECOVERY_GATE_FILE: gate } })).data;
    assert.equal(probe.step, 'success');
    const agent = (await api.post('/api/agents/custom', registration)).data;
    await api.post(`/api/agents/${encodeURIComponent(agent.id)}/health-check`);
    const assistant = (await api.get('/api/assistants')).data.find(item => item.agent_id === agent.id);
    assert.ok(assistant);
    const createConversation = async name => {
      const created = (await api.post('/api/conversations', { name, assistant: { id: assistant.id, locale: 'en-US', conversation_overrides: { mcp_ids: [] } },
        extra: { workspace, custom_workspace: true, selected_mcp_server_ids: [], selected_session_mcp_servers: [] } })).data;
      route = `/api/conversations/${encodeURIComponent(created.id)}`;
      return created;
    };
    if (!options.reference) {
      phase = 'atomic-update-reservation';
      const control = await createConversation('Synthetic update reservation control');
      const reservation = randomUUID();
      assert.equal((await api.post('/api/system/update/quiesce', { reservation_id: reservation })).data.reserved, true);
      const originalRows = snapshot(await messages());
      await expectRejected(`${route}/messages`, { content: 'THOR_STREAM_DIAGNOSTIC' });
      await expectRejected(`${route}/runtime/ensure`, {}, undefined, [400, 409]);
      assert.deepEqual(snapshot(await messages()), originalRows, 'Rejected work created an accepted message row.');
      assert.equal((await api.post('/api/system/update/release', { reservation_id: reservation })).data.reserved, false);
      await expectRejected('/api/system/update/quiesce', { reservation_id: reservation }, 'UPDATE_RESERVATION_REVOKED');
      const completed = await runCoreTurn(api, { conversationId: control.id, content: 'THOR_STREAM_DIAGNOSTIC', timeoutMs: 30000 });
      assert.ok(completed.assistantText.includes('THOR_STREAM_SECOND'));
      await expectRejected('/api/system/update/quiesce', { reservation_id: randomUUID() }, 'UPDATE_OPEN_RUNTIMES');
      await restart();
      const freshReservation = randomUUID();
      assert.equal((await api.post('/api/system/update/quiesce', { reservation_id: freshReservation })).data.reserved, true);
      await api.post('/api/system/update/release', { reservation_id: freshReservation });
      const canceledBeforeArrival = randomUUID();
      await api.post('/api/system/update/release', { reservation_id: canceledBeforeArrival });
      await expectRejected('/api/system/update/quiesce', { reservation_id: canceledBeforeArrival }, 'UPDATE_RESERVATION_REVOKED');
      evidence.quiesce = { executed: true, freshReservation: true, rejectedTurnHasNoAcceptedRow: true, runtimeCreationBlocked: true,
        releasePermitsTurn: true, usedEpochRejected: true, freshEpochPermitted: true, canceledRequestFencesDelayedArrival: true };
    } else evidence.quiesce = { executed: false, reason: 'The reference binary predates this policy.' };
    const untouched = await createConversation('Synthetic crash before task start');
    phase = 'before-task-start';
    const before = snapshot(await messages());
    await restart();
    assert.deepEqual(snapshot(await messages()), before);
    assert.equal((await api.get(route)).data.id, untouched.id);
    evidence.cases.beforeTaskStart = { passed: true, conversationPreserved: true, messagesUnchanged: true };

    await createConversation('Synthetic accepted request before ACP dispatch');
    phase = 'accepted-before-dispatch';
    await writeFile(gate, 'pause', { flag: 'wx' });
    const promptCountBeforeDispatch = await prompts();
    const sentBeforeDispatch = (await api.post(`${route}/messages`, { content: 'THOR_STREAM_DIAGNOSTIC' })).data;
    await wait(async () => { try { return JSON.parse(await readFile(gateObserved, 'utf8')).stage === 'before-initialize'; } catch { return false; } }, 'pre-dispatch initialization barrier');
    const acceptedRows = (await messages()).filter(row => row.id === sentBeforeDispatch.msg_id);
    assert.equal(acceptedRows.length, 1, 'Accepted user row was not durable.');
    assert.equal(await prompts(), promptCountBeforeDispatch, 'The barrier allowed a prompt to execute.');
    await kill(); await rm(gate); await start();
    await pause(350);
    assert.equal(await prompts(), promptCountBeforeDispatch, 'Startup automatically dispatched accepted work.');
    const acceptedTruthful = truthfulInterruption(await messages(), acceptedRows);
    evidence.cases.acceptedBeforeDispatch = { passed: acceptedTruthful, userInputPreserved: true, noPromptExecutedBeforeCrash: true,
      noAutomaticReplay: true, durableInterruptionNotice: acceptedTruthful };
    await resume();
    evidence.cases.acceptedBeforeDispatch.explicitContinuationSucceeded = true;

    await createConversation('Synthetic crash during unfinished output');
    phase = 'during-task';
    const priorIds = new Set((await messages()).map(row => row.id));
    await api.post(`${route}/messages`, { content: 'THOR_CANCEL_DIAGNOSTIC' });
    const partialRows = await wait(async () => {
      const rows = (await messages()).filter(row => !priorIds.has(row.id) && row.position === 'left' && row.type === 'text' && messageText(row).includes('THOR_CANCEL_WAITING'));
      return rows.length && rows.some(row => row.status === 'work') ? rows : undefined;
    }, 'durable in-progress output');
    const pendingPrompts = await prompts();
    await restart(); await pause(350);
    assert.equal(await prompts(), pendingPrompts, 'Startup replayed an unfinished prompt.');
    const recoveredPartial = await messages();
    const interruptedTruthful = truthfulInterruption(recoveredPartial, partialRows);
    const partialPreserved = partialRows.every(prior => recoveredPartial.some(saved => saved.id === prior.id && messageText(saved).includes(messageText(prior))));
    assert.equal(partialPreserved, true, 'Partial output was lost after restart.');
    evidence.cases.duringTask = { passed: interruptedTruthful, partialOutputPreserved: partialPreserved,
      noAutomaticReplay: true, markedInterruptedRatherThanFinished: interruptedTruthful };
    evidence.cases.duringTask.loadedOriginalSessionOnExplicitResume = await resume();
    assert.equal(evidence.cases.duringTask.loadedOriginalSessionOnExplicitResume, true);

    await createConversation('Synthetic crash after persisted result');
    phase = 'after-persisted-result';
    const completed = await runCoreTurn(api, { conversationId: route.split('/').at(-1), content: 'THOR_STREAM_DIAGNOSTIC', timeoutMs: 30000 });
    assert.ok(completed.assistantText.includes('THOR_STREAM_SECOND'));
    if (!options.reference) await wait(async () => (await messages()).some(row => row.position === 'right' && row.content?.thor_turn_intent?.state === 'settled'), 'settled turn receipt');
    const completedRows = snapshot(await messages());
    const completedPrompts = await prompts();
    await restart(); await pause(350);
    assert.deepEqual(snapshot(await messages()), completedRows, 'Completed result changed after crash/restart.');
    assert.equal(await prompts(), completedPrompts, 'Completed prompt was replayed on restart.');
    assert.equal(await resume(), true);
    evidence.cases.afterPersistedResult = { passed: true, resultAndStatusUnchanged: true, noAutomaticReplay: true, explicitContinuationSucceeded: true };
    evidence.workspaceFilePreservedAcrossRestarts = true;
    await kill();
    evidence.ownedProcessTreeStopped = true;
    evidence.passed = Object.values(evidence.cases).every(value => value.passed);
    if (options.evidence) await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    return evidence;
  } catch (error) {
    evidence.harnessFailureAt = phase;
    if (options.evidence) await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' }).catch(() => {});
    throw error;
  } finally { await kill(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { core: { type: 'string' }, bundle: { type: 'string' }, 'state-root': { type: 'string' }, evidence: { type: 'string' }, reference: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) process.stdout.write(usage);
  else {
    try { const result = await verifyRecovery(values); process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.passed) process.exitCode = 1; }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
