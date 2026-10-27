import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, link, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ProjectMemory, parseMemory, serializeMemory } from '../../agent/memory-store.mjs';

const fixture = async run => {
  const root = await mkdtemp(path.join(tmpdir(), 'thor-memory-'));
  try { await run(new ProjectMemory(root), root); }
  finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
};
const fact = index => ({ id: `fact-${index}`, title: `Synthetic fact ${index}`, source: 'Explicit synthetic acceptance request', content: `Invented preference value ${index}.` });

test('automatic memory accepts sourced direct-user facts and rejects external retention while explicit external requests remain possible', () => fixture(async memory => {
  await memory.save({ ...fact(0), origin: 'user', mode: 'automatic', source: 'User directly chose USD for the project' });
  assert.equal((await memory.get('fact-0')).mode, 'automatic');
  assert.equal((await memory.get('fact-0')).origin, 'user');
  await assert.rejects(memory.save({ ...fact(1), origin: 'external', mode: 'automatic', source: 'Mail body' }), { code: 'SOURCE_BOUNDARY' });
  await memory.save({ ...fact(1), origin: 'external', mode: 'explicit', source: 'User explicitly asked to retain this short external fact' });
  assert.equal((await memory.get('fact-1')).origin, 'external');
  assert.equal((await memory.list()).length, 2);
}));

test('20 sourced facts persist over five reopened stores, five update/delete operations preserve the rest', () => fixture(async (memory, root) => {
  for (let index = 0; index < 20; index++) await memory.save(fact(index));
  for (let restart = 0; restart < 5; restart++) {
    const reopened = new ProjectMemory(root);
    assert.equal((await reopened.list()).length, 20);
    for (let index = 0; index < 20; index++) assert.equal((await reopened.get(`fact-${index}`)).content, fact(index).content);
  }
  for (let index = 0; index < 5; index++) await memory.save({ ...fact(index), content: `Updated synthetic value ${index}.`, source: 'Explicit update request' });
  for (let index = 5; index < 10; index++) await memory.delete(`fact-${index}`);
  const reopened = new ProjectMemory(root);
  assert.equal((await reopened.list()).length, 15);
  for (let index = 0; index < 5; index++) assert.equal((await reopened.get(`fact-${index}`)).content, `Updated synthetic value ${index}.`);
  for (let index = 5; index < 10; index++) await assert.rejects(reopened.get(`fact-${index}`), { code: 'NOT_FOUND' });
  const raw = await readFile(path.join(root, 'THOR_MEMORY.md'), 'utf8');
  assert.match(raw, /Explicit update request/);
  assert.deepEqual(parseMemory(serializeMemory(await reopened.read())), await reopened.read());
}));

test('concurrent writes merge under a lock without lost records', () => fixture(async memory => {
  await Promise.all(Array.from({ length: 20 }, (_, index) => memory.save(fact(index))));
  assert.equal((await memory.list()).length, 20);
}));

test('paths, credentials, oversized content and unsupported manual edits are rejected without replacement', () => fixture(async (memory, root) => {
  await assert.rejects(memory.save({ ...fact(0), id: '../cookies' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(memory.save({ ...fact(0), content: 'Cookie: synthetic-session=1234567890123456' }), { code: 'SENSITIVE_DATA' });
  for (const content of ['Authorization: Basic CANARY_BASIC', '{"Authorization":"Basic CANARY_BASIC"}', '{"token":"CANARY_JSON_0123456789"}', 'github_pat_CANARY_PAT_0123456789', '{"api_key":"CANARY_API_0123456789"}', 'Authorization: Digest CANARY_DIGEST']) await assert.rejects(memory.save({ ...fact(0), content }), { code: 'SENSITIVE_DATA' });
  await assert.rejects(memory.save({ ...fact(0), content: 'a'.repeat(4001) }), { code: 'INVALID_ARGUMENT' });
  const file = path.join(root, 'THOR_MEMORY.md');
  await writeFile(file, 'unrecognized user edits must not be erased');
  await assert.rejects(memory.save(fact(1)), { code: 'INVALID_FILE' });
  assert.equal(await readFile(file, 'utf8'), 'unrecognized user edits must not be erased');
}));

test('explicit recovery refuses a live writer and recovers a killed writer without changing saved facts', () => fixture(async (memory, root) => {
  await memory.save(fact(0));
  const before = await readFile(path.join(root, 'THOR_MEMORY.md'), 'utf8');
  const lockPath = path.join(root, '.THOR_MEMORY.lock');
  const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,pid:process.pid,nonce:"synthetic-killed-writer",createdAt:new Date().toISOString()}));process.stdout.write("READY\\n");setInterval(()=>{},1000);', lockPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    await assert.rejects(memory.recover(), { code: 'BUSY' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    assert.equal((await memory.recover()).recovered, true);
    assert.equal(await readFile(path.join(root, 'THOR_MEMORY.md'), 'utf8'), before);
    await memory.save(fact(1));
    assert.equal((await memory.list()).length, 2);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}));

test('hardlinked memory cannot read or overwrite another file', () => fixture(async (memory, root) => {
  const other = path.join(root, 'private-cookie-fixture');
  await writeFile(other, 'synthetic private content');
  await link(other, path.join(root, 'THOR_MEMORY.md'));
  await assert.rejects(memory.read(), { code: 'UNSAFE_PATH' });
  await assert.rejects(memory.save(fact(0)), { code: 'UNSAFE_PATH' });
  assert.equal(await readFile(other, 'utf8'), 'synthetic private content');
}));

test('junction workspace cannot traverse to another directory', () => fixture(async (memory, root) => {
  const junction = `${root}-junction`;
  try {
    await symlink(root, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(new ProjectMemory(junction).read(), { code: 'UNSAFE_PATH' });
  } finally { await rm(junction, { force: true }); }
}));
