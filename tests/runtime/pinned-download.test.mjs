import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerifiedFile } from '../../agent/tools/prepare-officecli.mjs';

const content = Buffer.from('synthetic executable download');
const sha256 = createHash('sha256').update(content).digest('hex');
const fixture = async run => {
  const root = await mkdtemp(path.join(tmpdir(), 'thor-pinned-download-'));
  try { await run(path.join(root, 'officecli'), root); }
  finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
};
const options = filePath => ({ url: 'https://example.invalid/pinned-asset', filePath, sha256, size: content.length });

test('verified binary publication, offline reuse, and corrupted artifact repair', () => fixture(async filePath => {
  assert.equal((await downloadVerifiedFile({ ...options(filePath), fetchImpl: async () => new Response(content) })).reused, false);
  assert.deepEqual(await readFile(filePath), content);
  assert.equal((await downloadVerifiedFile({ ...options(filePath), fetchImpl: async () => { throw new Error('offline'); } })).reused, true);
  await writeFile(filePath, Buffer.alloc(content.length));
  assert.equal((await downloadVerifiedFile({ ...options(filePath), fetchImpl: async () => new Response(content) })).reused, false);
}));

test('checksum mismatch, truncated response, excess bytes and network failure never publish executable', () => fixture(async (filePath, root) => {
  for (const body of [Buffer.alloc(content.length), content.subarray(0, 2), Buffer.alloc(content.length + 1)]) {
    await assert.rejects(downloadVerifiedFile({ ...options(filePath), fetchImpl: async () => new Response(body) }), /mismatch|exceeded/);
    await assert.rejects(readFile(filePath), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), []);
  }
  await assert.rejects(downloadVerifiedFile({ ...options(filePath), fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await readdir(root), []);
}));

test('concurrent builders serialize and second builder reuses verified result', () => fixture(async filePath => {
  let requests = 0;
  const fetchImpl = async () => { requests++; await new Promise(resolve => setTimeout(resolve, 50)); return new Response(content); };
  const replies = await Promise.all([downloadVerifiedFile({ ...options(filePath), fetchImpl }), downloadVerifiedFile({ ...options(filePath), fetchImpl })]);
  assert.equal(requests, 1);
  assert.deepEqual(replies.map(reply => reply.reused).sort(), [false, true]);
  assert.deepEqual(await readFile(filePath), content);
}));
