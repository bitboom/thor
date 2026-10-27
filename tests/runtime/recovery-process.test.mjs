import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecoveryProcessOwner } from '../../agent/tools/owned-recovery-process.mjs';
import { verifyRecovery } from '../../agent/tools/verify-recovery.mjs';

const handle = values => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }, values);

test('an empty recovery owner permits stop without invoking termination', async () => {
  const owner = createRecoveryProcessOwner({ terminate: () => assert.fail('No child is owned.') });
  await owner.stop();
  owner.assertCanStart();
});

test('exited, signaled and missing-PID handles cannot be killed or replaced', async () => {
  for (const state of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGTERM' }, { pid: undefined }, { pid: 0 }]) {
    let terminated = false;
    const owner = createRecoveryProcessOwner({ terminate: () => { terminated = true; } });
    owner.start(() => handle(state));
    await assert.rejects(owner.stop(), /cleanup is unproven/);
    assert.equal(terminated, false, 'An unproven numeric PID must never reach termination.');
    assert.throws(() => owner.assertCanStart(), /cleanup is unproven/);
    assert.throws(() => owner.start(() => assert.fail('Restart overwrote the unproven child.')), /cleanup is unproven/);
  }
});

test('termination failure and an unobserved exit keep restart blocked', async () => {
  for (const terminate of [async () => { throw new Error('termination failed'); }, async owned => { owned.exitCode = 0; }]) {
    const owned = handle();
    const owner = createRecoveryProcessOwner({ terminate, timeoutMs: 10 });
    owner.start(() => owned);
    await assert.rejects(owner.stop(), /termination failed|exit was not observed/);
    assert.equal(owned.listenerCount('exit'), 0);
    assert.throws(() => owner.start(() => handle()), /cleanup is unproven/);
  }
});

test('an exit event without recorded process state cannot prove cleanup', async () => {
  const owner = createRecoveryProcessOwner({ terminate: async owned => { owned.emit('exit', 0); } });
  owner.start(() => handle());
  await assert.rejects(owner.stop(), /exit state was not recorded/);
  assert.throws(() => owner.assertCanStart(), /cleanup is unproven/);
});

test('only successful termination and an observed exit release ownership', async () => {
  let release;
  const owned = handle();
  const owner = createRecoveryProcessOwner({ terminate: () => new Promise(resolve => { release = resolve; }) });
  owner.start(() => owned);
  const stopping = owner.stop();
  assert.throws(() => owner.start(() => handle()), /cleanup is unproven/);
  await assert.rejects(owner.stop(), /already in progress/);
  owned.exitCode = 1;
  owned.emit('exit', 1);
  release();
  await stopping;
  assert.equal(owned.listenerCount('exit'), 0);
  owner.assertCanStart();
  assert.equal(owner.start(() => handle()).pid, 123);
});

test('a real child that already exited never reaches a termination callback or restart', async () => {
  let terminated = false;
  const owner = createRecoveryProcessOwner({ terminate: () => { terminated = true; } });
  const child = owner.start(() => spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' }));
  await once(child, 'exit');
  await assert.rejects(owner.stop(), /exited before tree termination/);
  assert.equal(terminated, false);
  assert.throws(() => owner.start(() => assert.fail('Unexpected restart.')), /cleanup is unproven/);
});

test('real-child termination observes exit before ownership is reusable', async t => {
  const owner = createRecoveryProcessOwner({ terminate: async child => { assert.equal(child.kill(), true); } });
  const child = owner.start(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  });
  await once(child, 'spawn');
  await owner.stop();
  assert.ok(Number.isInteger(child.exitCode) || typeof child.signalCode === 'string');
  owner.assertCanStart();
});

test('the verifier records cleanup failure before writing final failure evidence', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'thor-recovery-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, 'evidence.json');
  // Node rejects the Core-specific arguments and exits before readiness. This
  // tests verifier failure handling, never Core recovery or model behavior.
  await assert.rejects(verifyRecovery({ core: process.execPath, bundle: root, 'state-root': root, evidence: evidencePath }),
    /cleanup is unproven/);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(evidence.passed, false);
  assert.equal(evidence.ownedProcessTreeStopped, false);
  assert.equal(evidence.harnessFailureAt, 'owned-process-cleanup');
  assert.deepEqual(evidence.cases, {});
});
