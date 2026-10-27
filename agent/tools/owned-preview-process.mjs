import assert from 'node:assert/strict';
import path from 'node:path';

// Acceptance process ownership support. An unexpected exited root never
// proves its descendants stopped and must never be killed by a recycled PID.
export function createPreviewProcessOwner({ terminate, requireClosed, exitTimeoutMs = 5000, closeTimeoutMs = 40000 }) {
  const children = new Map();
  const ports = new Set();
  let busy = false;

  function assertLive(record) {
    assert.ok(record, 'Owned preview process is missing.');
    const { child, role } = record;
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, `Owned ${role} PID is missing; cleanup is unproven.`);
    assert.ok(!record.spawnError && !record.observed && child.exitCode === null && child.signalCode === null,
      `Owned ${role} exited unexpectedly; cleanup is unproven.`);
  }

  async function observedExit(record, timeout) {
    if (!record.observed) {
      let timer;
      let resolveExit;
      const exited = new Promise(resolve => { resolveExit = resolve; record.waiters.add(resolve); });
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Owned ${record.role} exit was not observed; cleanup is unproven.`)), timeout);
        })]);
      } finally { clearTimeout(timer); record.waiters.delete(resolveExit); }
    }
    assert.ok(record.observed && (Number.isInteger(record.child.exitCode)
      || (typeof record.child.signalCode === 'string' && record.child.signalCode.length > 0)),
    `Owned ${record.role} exit state was not recorded; cleanup is unproven.`);
  }

  async function closedPorts() {
    const failures = [];
    for (const port of ports) { try { await requireClosed(port); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Owned preview ports did not all close; cleanup is unproven.');
  }

  function release() {
    for (const record of children.values()) {
      record.child.removeListener('exit', record.onExit);
      record.child.removeListener('error', record.onError);
    }
    children.clear();
    ports.clear();
  }

  return {
    adopt(role, child) {
      assert.equal(busy, false, 'Preview cleanup is already in progress.');
      assert.ok(!children.has(role), `Previous owned ${role} cleanup is unproven.`);
      assert.ok(child, `Owned ${role} handle is missing.`);
      const record = { child, role, observed: false, intent: null, waiters: new Set() };
      record.onExit = (code, signal) => {
        record.observed = true; record.exitCode = code; record.signalCode = signal;
        for (const resolve of record.waiters) resolve();
      };
      record.onError = error => { record.spawnError = error; };
      child.once('exit', record.onExit);
      child.once('error', record.onError);
      children.set(role, record);
      return child;
    },
    assertLive() {
      assertLive(children.get('Core'));
      for (const record of children.values()) assertLive(record);
    },
    trackPort(port) {
      assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
      assertLive(children.get('Core'));
      ports.add(port);
    },
    async close({ requestParentExit, requestCoreExit }) {
      assert.equal(busy, false, 'Preview cleanup is already in progress.');
      assertLive(children.get('Core'));
      for (const record of children.values()) assertLive(record);
      busy = true;
      try {
        const core = children.get('Core');
        const parent = children.get('parent');
        // Register intent before invoking the intentional shutdown action, so
        // the resulting observed parent exit is distinct from a prior crash.
        core.intent = 'parent-close';
        if (parent) {
          parent.intent = 'parent-close';
          await requestParentExit(parent.child);
          await observedExit(parent, exitTimeoutMs);
          assert.equal(parent.exitCode, 0, 'Owned parent close returned a failure.');
        } else await requestCoreExit(core.child);
        await observedExit(core, closeTimeoutMs);
        assert.equal(core.exitCode, 0, 'Core graceful close returned a failure.');
        await closedPorts();
        release();
      } finally { busy = false; }
    },
    async cleanup() {
      if (children.size === 0) return;
      assert.equal(busy, false, 'Preview cleanup is already in progress.');
      busy = true;
      const failures = [];
      try {
        for (const record of children.values()) {
          try {
            if (record.observed && record.intent) await observedExit(record, exitTimeoutMs);
            else {
              assertLive(record);
              record.intent = 'force-stop';
              await terminate(record.child);
              record.terminationSucceeded = true;
              await observedExit(record, exitTimeoutMs);
            }
            assert.ok(record.intent !== 'force-stop' || record.terminationSucceeded,
              'Owned process-tree termination failed; cleanup is unproven.');
          } catch (error) { failures.push(error); }
        }
        try { await closedPorts(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Owned preview process cleanup is unproven.');
        release();
      } finally { busy = false; }
    },
  };
}

export async function finishPreviewEvidence({ result, failure, cleanup, writeEvidence }) {
  const failures = failure ? [failure] : [];
  const cleanupFailures = [];
  for (const action of cleanup) {
    try { await action(); } catch (error) { cleanupFailures.push(error); }
  }
  result.cleanupCompleted = cleanupFailures.length === 0;
  result.passed = result.passed === true && failures.length === 0 && cleanupFailures.length === 0;
  failures.push(...cleanupFailures);
  // A write failure must also propagate. No success is returned or printed
  // before every cleanup action and the final evidence write have completed.
  if (writeEvidence) await writeEvidence(result);
  if (failures.length) throw new AggregateError(failures, 'Office preview acceptance or final cleanup failed.');
  return result;
}

export function plannedFixturePaths(workspace, formats) {
  return formats.flatMap(({ format }) => [
    path.join(workspace, `synthetic-original.${format}`), path.join(workspace, `synthetic-copy.${format}`),
  ]);
}

export async function closeFixtureResidents(paths, close) {
  const failures = [];
  for (const file of paths) { try { await close(file); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'Final OfficeCLI close failed.');
}

export async function runPreviewAcceptance({ result, verify, cleanup, writeEvidence }) {
  let failure;
  try { await verify(); result.passed = true; }
  catch (error) { failure = error; }
  return finishPreviewEvidence({ result, failure, cleanup, writeEvidence });
}
