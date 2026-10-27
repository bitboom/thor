import assert from 'node:assert/strict';

// Keep an unproven handle owned: an exited root cannot prove its descendants
// stopped, and its numeric PID must never be sent to a later taskkill request.
export function createRecoveryProcessOwner({ terminate, timeoutMs = 5000 }) {
  let child;
  let stopping = false;
  const assertCanStart = () => assert.equal(child, undefined, 'Previous owned Core cleanup is unproven.');
  return {
    assertCanStart,
    start(createChild) {
      assertCanStart();
      child = createChild();
      assert.ok(child, 'Core spawn did not return an owned process handle.');
      return child;
    },
    async stop() {
      if (child === undefined) return;
      assert.equal(stopping, false, 'Owned Core termination is already in progress.');
      const owned = child;
      assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 0, 'Owned Core PID is missing; cleanup is unproven.');
      assert.equal(owned.exitCode, null, 'Owned Core exited before tree termination; cleanup is unproven.');
      assert.equal(owned.signalCode, null, 'Owned Core was signaled before tree termination; cleanup is unproven.');
      stopping = true;
      let timer;
      let onExit;
      const exited = new Promise(resolve => { onExit = resolve; owned.once('exit', onExit); });
      try {
        await terminate(owned);
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned Core exit was not observed; cleanup is unproven.')), timeoutMs);
        })]);
        assert.ok(Number.isInteger(owned.exitCode) || (typeof owned.signalCode === 'string' && owned.signalCode.length > 0),
          'Owned Core exit state was not recorded; cleanup is unproven.');
        child = undefined;
      } finally {
        clearTimeout(timer);
        owned.removeListener('exit', onExit);
        stopping = false;
      }
    },
  };
}
