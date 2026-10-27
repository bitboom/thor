import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { truthfulInterruption } from '../../agent/tools/verify-recovery.mjs';

test('recovery acceptance rejects finished partial output and requires preserved interruption metadata', () => {
  const before = [{ id: 'partial', type: 'text', position: 'left', status: 'work', content: { content: 'partial result' } }];
  assert.equal(truthfulInterruption([{ ...before[0], status: 'finish' }], before), false);
  const tip = { type: 'tips', content: { code: 'THOR_WORK_INTERRUPTED', recovery: { remote_outcome: 'unknown', automatic_replay: false } } };
  const recovered = { ...before[0], status: 'error', content: { content: 'partial result', thor_recovery: { state: 'interrupted' } } };
  assert.equal(truthfulInterruption([tip, recovered], before), true);
  assert.equal(truthfulInterruption([tip, { ...recovered, content: { content: 'replaced output', thor_recovery: { state: 'interrupted' } } }], before), false);
});

test('real ACP pre-initialization barrier prevents dispatch until explicitly released', { timeout: 10000 }, async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'thor-recovery-gate-'));
  const gate = path.join(state, 'before-initialize.gate');
  await writeFile(gate, 'pause');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../agent/tools/recovery-acp.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, THOR_MOCK_STATE_DIR: state, THOR_RECOVERY_GATE_FILE: gate },
  });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; } await rm(state, { recursive: true, force: true }); });
  const frames = [];
  createInterface({ input: child.stdout }).on('line', line => frames.push(JSON.parse(line)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
  const deadline = Date.now() + 3000;
  while (true) {
    try { assert.equal(JSON.parse(await readFile(path.join(state, 'gate-observed.json'), 'utf8')).stage, 'before-initialize'); break; }
    catch { if (Date.now() > deadline) throw new Error('Gate was not reached.'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(frames.length, 0);
  await assert.rejects(readFile(path.join(state, 'methods.jsonl')), { code: 'ENOENT' });
  await rm(gate);
  while (!frames.length) { if (Date.now() > deadline) throw new Error('ACP did not initialize after release.'); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(frames[0].result.protocolVersion, 1);
});
