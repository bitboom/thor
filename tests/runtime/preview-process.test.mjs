import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createPreviewProcessOwner, finishPreviewEvidence, plannedFixturePaths, closeFixtureResidents, runPreviewAcceptance } from '../../agent/tools/owned-preview-process.mjs';

const handle = state => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }, state);
const exit = (child, code = 0, signal = null) => {
  child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
};
const create = options => createPreviewProcessOwner({ terminate: async () => assert.fail('Unexpected forced termination.'),
  requireClosed: async () => {}, exitTimeoutMs: 10, closeTimeoutMs: 10, ...options });
const requestNothing = { requestParentExit: async () => assert.fail('Unexpected parent-close request.'),
  requestCoreExit: async () => assert.fail('Unexpected Core-close request.') };

test('an empty owner permits cleanup only, never a graceful-close claim', async () => {
  const owner = create();
  await owner.cleanup();
  await assert.rejects(owner.close(requestNothing), /process is missing/);
});

test('already-exited, signaled and missing-PID Core handles never reach kill or graceful close', async () => {
  for (const state of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGTERM' }, { pid: undefined }, { pid: 0 }]) {
    const owner = create();
    owner.adopt('Core', handle(state));
    await assert.rejects(owner.close(requestNothing), /cleanup is unproven/);
    await assert.rejects(owner.cleanup(), /cleanup is unproven/);
    assert.throws(() => owner.adopt('Core', handle()), /cleanup is unproven/);
  }
});

test('an observed unexpected root exit retains ownership and does not kill that numeric PID', async () => {
  const killed = [];
  const owner = create({ terminate: async child => { killed.push(child.pid); exit(child, 1); } });
  const core = owner.adopt('Core', handle({ pid: 123 }));
  owner.adopt('parent', handle({ pid: 456 }));
  exit(core);
  await assert.rejects(owner.close(requestNothing), /exited unexpectedly/);
  await assert.rejects(owner.cleanup(), /cleanup is unproven/);
  assert.deepEqual(killed, [456], 'The live sentinel should still be cleaned, never the exited Core PID.');
  assert.throws(() => owner.adopt('Core', handle()), /cleanup is unproven/);
});

test('an already-exited parent cannot satisfy a graceful-close request', async () => {
  const killed = [];
  const owner = create({ terminate: async child => { killed.push(child.pid); exit(child, 1); } });
  owner.adopt('Core', handle({ pid: 123 }));
  const parent = owner.adopt('parent', handle({ pid: 456 }));
  exit(parent);
  assert.throws(() => owner.assertLive(), /parent exited unexpectedly/);
  await assert.rejects(owner.close(requestNothing), /parent exited unexpectedly/);
  await assert.rejects(owner.cleanup(), /cleanup is unproven/);
  assert.deepEqual(killed, [123]);
});

test('intentional parent exit, Core zero exit and every closed port release the owner', async () => {
  const checked = [];
  const owner = create({ requireClosed: async port => { checked.push(port); } });
  const core = owner.adopt('Core', handle());
  const parent = owner.adopt('parent', handle({ pid: 456 }));
  owner.trackPort(12345); owner.trackPort(23456);
  await owner.close({ requestParentExit: async child => { assert.equal(child, parent); exit(parent); exit(core); } });
  assert.deepEqual(checked, [12345, 23456]);
  assert.equal(core.listenerCount('exit'), 0);
  await owner.cleanup(); // expected, already-observed intentional exits
  owner.adopt('Core', handle());
});

test('graceful close requires an observed zero Core exit and closed preview ports', async () => {
  for (const nonzero of [true, false]) {
    let portChecks = 0;
    const owner = create({ requireClosed: async () => { portChecks++; throw new Error('port still open'); } });
    const core = owner.adopt('Core', handle());
    owner.trackPort(12345);
    await assert.rejects(owner.close({ requestCoreExit: async () => exit(core, nonzero ? 1 : 0) }),
      nonzero ? /graceful close returned a failure/ : /ports did not all close/);
    assert.equal(portChecks, nonzero ? 0 : 1);
    assert.throws(() => owner.adopt('Core', handle()), /cleanup is unproven/);
  }
});

test('taskkill failure is retained even if the process exits during the failed request', async () => {
  let calls = 0;
  const owner = create({ terminate: async child => { calls++; exit(child, 1); throw new Error('taskkill failed'); } });
  owner.adopt('Core', handle());
  await assert.rejects(owner.cleanup(), /cleanup is unproven/);
  await assert.rejects(owner.cleanup(), /cleanup is unproven/);
  assert.equal(calls, 1, 'An already-exited numeric PID must not be retried.');
  assert.throws(() => owner.adopt('Core', handle()), /cleanup is unproven/);
});

test('exit fields without an observed event and events without exit state are inconclusive', async () => {
  for (const terminate of [async child => { child.exitCode = 1; }, async child => { child.emit('exit', 1); }]) {
    const owner = create({ terminate });
    owner.adopt('Core', handle());
    await assert.rejects(owner.cleanup(), /cleanup is unproven/);
    assert.throws(() => owner.adopt('Core', handle()), /cleanup is unproven/);
  }
});

test('successful force cleanup waits for all owned exits and ports before releasing handles', async () => {
  const sequence = [];
  const owner = create({ terminate: async child => { sequence.push(`kill:${child.pid}`); exit(child, 1); },
    requireClosed: async port => { sequence.push(`closed:${port}`); } });
  owner.adopt('Core', handle()); owner.adopt('parent', handle({ pid: 456 }));
  owner.trackPort(12345); owner.trackPort(23456);
  await owner.cleanup();
  assert.deepEqual(sequence, ['kill:123', 'kill:456', 'closed:12345', 'closed:23456']);
  owner.adopt('Core', handle());
});

test('evidence is written only after every cleanup action; cleanup errors force failure', async () => {
  for (const failCleanup of [false, true]) {
    const sequence = [];
    const result = { passed: true };
    const operation = finishPreviewEvidence({ result, cleanup: [async () => { sequence.push('Core+ports');
      if (failCleanup) throw new Error('Core cleanup failed'); }, async () => { sequence.push('CLI close'); }],
    writeEvidence: async saved => {
      assert.deepEqual(sequence, ['Core+ports', 'CLI close']);
      assert.equal(saved.passed, !failCleanup);
      assert.equal(saved.cleanupCompleted, !failCleanup);
      sequence.push('evidence');
    } });
    if (failCleanup) await assert.rejects(operation, /final cleanup failed/);
    else assert.equal((await operation).passed, true);
    assert.deepEqual(sequence, ['Core+ports', 'CLI close', 'evidence']);
  }
});

test('CLI-close failure, prior validation failure and evidence-write failure cannot return success', async () => {
  for (const which of ['CLI', 'validation', 'write']) {
    let wrote = false;
    await assert.rejects(finishPreviewEvidence({ result: { passed: true },
      failure: which === 'validation' ? new Error('validation failed') : undefined,
      cleanup: [async () => { if (which === 'CLI') throw new Error('CLI close failed'); }],
      writeEvidence: async result => {
        wrote = true;
        if (which === 'write') throw new Error('write failed');
        assert.equal(result.passed, false);
      } }), which === 'write' ? /write failed/ : /acceptance or final cleanup failed/);
    assert.equal(wrote, true);
  }
});

test('partial fixture failure still closes all six pre-registered original/copy paths before evidence', async () => {
  const workspace = path.resolve('synthetic-fixture-workspace');
  const paths = plannedFixturePaths(workspace, ['docx', 'xlsx', 'pptx'].map(format => ({ format })));
  assert.deepEqual(paths, ['docx', 'xlsx', 'pptx'].flatMap(format => [
    path.join(workspace, `synthetic-original.${format}`), path.join(workspace, `synthetic-copy.${format}`),
  ]));
  const sequence = [];
  await assert.rejects(runPreviewAcceptance({ result: { passed: false }, verify: async () => {
    sequence.push(`create:${paths[0]}`);
    throw new Error('injected fixture add failure');
  }, cleanup: [() => closeFixtureResidents(paths, async file => { sequence.push(`close:${file}`); })],
  writeEvidence: async result => {
    assert.equal(result.passed, false);
    assert.equal(result.cleanupCompleted, true);
    assert.deepEqual(sequence, [`create:${paths[0]}`, ...paths.map(file => `close:${file}`)]);
    sequence.push('failure evidence');
  } }), /acceptance or final cleanup failed/);
  assert.equal(sequence.at(-1), 'failure evidence');
});

test('one fixture-close error cannot skip remaining paths or become successful evidence', async () => {
  const paths = ['original.docx', 'copy.docx', 'original.xlsx', 'copy.xlsx', 'original.pptx', 'copy.pptx'];
  const attempts = [];
  await assert.rejects(runPreviewAcceptance({ result: { passed: false }, verify: async () => {},
    cleanup: [() => closeFixtureResidents(paths, async file => {
      attempts.push(file); if (file === paths[0]) throw new Error('close failed');
    })], writeEvidence: async result => {
      assert.deepEqual(attempts, paths);
      assert.equal(result.passed, false);
      assert.equal(result.cleanupCompleted, false);
    } }), /acceptance or final cleanup failed/);
});
