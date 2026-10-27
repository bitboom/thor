import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { treeEntries, snapshotDigest, sha256, validateManifest, verifyPatch } from './lib.mjs';

const lock = {
  desktop: { repository: 'https://github.com/iOfficeAI/AionUi', directory: 'desktop/aionui', commit: 'a'.repeat(40) },
  host: { repository: 'https://github.com/iOfficeAI/AionCore', directory: 'host/aioncore', commit: 'b'.repeat(40) },
};
const manifest = () => ({ schemaVersion: 1, version: '0.1.0', sourceTreeSha256: 'c'.repeat(64), sourceTreeFileCount: 42, upstream: structuredClone(lock), patch: { file: 'release/bootstrap/integration.patch', sha256: 'd'.repeat(64) } });

test('canonical snapshot includes file paths, modes and Git blob identities', () => {
  const base = treeEntries(Buffer.from(`100644 blob ${'a'.repeat(40)}\tREADME.md\0`));
  assert.notEqual(snapshotDigest(base), snapshotDigest([{ ...base[0], mode: '100755' }]));
  assert.notEqual(snapshotDigest(base), snapshotDigest([{ ...base[0], path: 'changed.md' }]));
  assert.notEqual(snapshotDigest(base), snapshotDigest([{ ...base[0], object: 'b'.repeat(40) }]));
});

test('generated bootstrap transport files do not change reconstructed source identity', () => {
  const source = [{ mode: '100644', object: 'a'.repeat(40), path: 'README.md' }];
  assert.equal(snapshotDigest(source), snapshotDigest([...source, { mode: '100644', object: 'b'.repeat(40), path: 'release/bootstrap/manifest.json' }]));
});

test('rejects Git submodule entries instead of dropping them from the source digest', () => {
  assert.throws(() => treeEntries(Buffer.from(`160000 commit ${'a'.repeat(40)}\tmodule\0`)), /without Git submodules/);
});

test('checks both upstream repository and exact revision', () => {
  assert.doesNotThrow(() => validateManifest(manifest(), lock));
  const changed = manifest();
  changed.upstream.host.commit = 'e'.repeat(40);
  assert.throws(() => validateManifest(changed, lock), /pinned upstream lock/);
  changed.upstream.host.commit = lock.host.commit;
  changed.upstream.host.repository = 'https://example.invalid/other';
  assert.throws(() => validateManifest(changed, lock), /pinned upstream lock/);
});

test('rejects malformed source digests and unsafe patch paths', () => {
  const changed = manifest();
  changed.sourceTreeSha256 = 'invalid';
  assert.throws(() => validateManifest(changed, lock), /source manifest/);
  changed.sourceTreeSha256 = 'c'.repeat(64);
  changed.patch.file = '../patch';
  assert.throws(() => validateManifest(changed, lock), /patch manifest/);
});

test('allows reviewed subtree patches and rejects altered bytes or root-file edits', () => {
  const patch = Buffer.from('diff --git a/desktop/aionui/package.json b/desktop/aionui/package.json\n');
  assert.doesNotThrow(() => verifyPatch(patch, sha256(patch)));
  assert.throws(() => verifyPatch(Buffer.concat([patch, Buffer.from('altered')]), sha256(patch)), /checksum/);
  const escaped = Buffer.from('diff --git a/.github/workflows/windows-release.yml b/.github/workflows/windows-release.yml\n');
  assert.throws(() => verifyPatch(escaped, sha256(escaped)), /only the two pinned source subtrees/);
});

test('reconstructs shallow pinned subtrees and binary patches before pushing a matching local source tree', t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'thor-bootstrap-git-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const init = directory => {
    mkdirSync(directory, { recursive: true });
    git(directory, ['init', '--initial-branch=main']);
    git(directory, ['config', 'user.name', 'Synthetic fixture']);
    git(directory, ['config', 'user.email', 'fixture@example.invalid']);
    git(directory, ['config', 'core.autocrlf', 'false']);
  };
  const upstreams = {};
  const pins = {};
  for (const name of ['desktop', 'host']) {
    const directory = path.join(temporary, `upstream-${name}`);
    init(directory);
    writeFileSync(path.join(directory, 'source.txt'), `${name} upstream source\n`);
    writeFileSync(path.join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'fixture upstream']);
    upstreams[name] = directory;
    pins[name] = { ...lock[name], commit: git(directory, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  }
  const checkout = path.join(temporary, 'checkout');
  init(checkout);
  const helpers = path.join(checkout, 'release/bootstrap');
  mkdirSync(helpers, { recursive: true });
  for (const file of ['run.mjs', 'lib.mjs']) copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), file), path.join(helpers, file));
  writeFileSync(path.join(checkout, 'upstream.lock.json'), JSON.stringify(pins));
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'fixture root source']);
  for (const name of ['desktop', 'host']) git(checkout, ['fetch', '--depth=1', pathToFileURL(upstreams[name]).href, pins[name].commit]);
  const envIndex = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  git(checkout, ['read-tree', 'HEAD'], { env: envIndex });
  for (const name of ['desktop', 'host']) git(checkout, ['read-tree', `--prefix=${pins[name].directory}/`, `${pins[name].commit}^{tree}`], { env: envIndex });
  const base = git(checkout, ['write-tree'], { env: envIndex, encoding: 'utf8' }).trim();
  for (const [file, bytes] of [
    ['desktop/aionui/source.txt', Buffer.from('Thor desktop integration\n')],
    ['host/aioncore/binary.dat', Buffer.from([0, 255, 254, 253, 0])],
  ]) {
    const object = git(checkout, ['hash-object', '-w', '--stdin'], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
    git(checkout, ['update-index', '--add', '--cacheinfo', `100644,${object},${file}`], { env: envIndex });
  }
  const desired = git(checkout, ['write-tree'], { env: envIndex, encoding: 'utf8' }).trim();
  const expected = treeEntries(git(checkout, ['ls-tree', '-rz', desired]));
  const patch = git(checkout, ['diff', '--binary', '--full-index', base, desired, '--', 'desktop/aionui', 'host/aioncore']);
  const sourceManifest = { schemaVersion: 1, version: '0.1.0', sourceTreeSha256: snapshotDigest(expected), sourceTreeFileCount: expected.length, upstream: pins, patch: { file: 'release/bootstrap/integration.patch', sha256: sha256(patch) } };
  writeFileSync(path.join(helpers, 'integration.patch'), patch);
  writeFileSync(path.join(helpers, 'manifest.json'), JSON.stringify(sourceManifest));
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'fixture reviewed seed']);
  const seed = git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bare = path.join(temporary, 'origin.git');
  git(temporary, ['init', '--bare', '--initial-branch=main', bare]);
  git(checkout, ['remote', 'add', 'origin', bare]);
  git(checkout, ['push', '-u', 'origin', 'main']);
  for (const name of ['desktop', 'host']) git(checkout, ['config', `url.${pathToFileURL(upstreams[name]).href}.insteadOf`, pins[name].repository]);
  const capture = path.join(temporary, 'dispatch.json');
  const hook = path.join(temporary, 'dispatch-hook.mjs');
  writeFileSync(hook, `import cp from 'node:child_process'; import {writeFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=cp.execFileSync; cp.execFileSync=(command,args,options)=>{if(command==='gh'){writeFileSync(process.env.THOR_TEST_CAPTURE,JSON.stringify(args)); return Buffer.alloc(0);} return original(command,args,options);}; syncBuiltinESMExports();`);
  const environment = { ...process.env, GITHUB_OUTPUT: path.join(temporary, 'step-output.txt'), GITHUB_REPOSITORY: 'bitboom/thor', GITHUB_SHA: seed, THOR_BOOTSTRAP_SEED_SHA: seed, GH_TOKEN: 'synthetic-test-token', THOR_TEST_CAPTURE: capture, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` };
  execFileSync(process.execPath, [path.join(helpers, 'run.mjs')], { cwd: checkout, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const remoteTree = treeEntries(git(checkout, ['--git-dir', bare, 'ls-tree', '-rz', 'refs/heads/main']));
  assert.equal(snapshotDigest(remoteTree), sourceManifest.sourceTreeSha256);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['workflow', 'run', 'windows-release.yml', '--repo', 'bitboom/thor', '--ref', 'main']);
  const history = git(checkout, ['log', '--format=%B', '--all'], { encoding: 'utf8' });
  assert.match(history, /git-subtree-dir: desktop\/aionui/);
  assert.match(history, /git-subtree-dir: host\/aioncore/);
  git(checkout, ['checkout', '--detach', seed]);
  assert.throws(() => execFileSync(process.execPath, [path.join(helpers, 'run.mjs')], { cwd: checkout, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }), /main moved after seed review/);
});
