import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateRequest, validateRun, selectArtifact, validateProvenance, requireNewVersion } from './contract.mjs';
import { localBoundaryPolicy, requiredLocalBoundaryChecks } from '../local-boundary-policy.mjs';
import { nativeDesktopPolicy, nativeDesktopElectron, nativeDesktopAbi, sqliteNativeFile } from '../native-policy.mjs';

const request = () => ({ schemaVersion: 1, sourceSha: 'a'.repeat(40), runId: 40539274541, version: '0.1.0' });
const run = () => ({ id: 40539274541, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', repository: { full_name: 'bitboom/thor' }, head_repository: { full_name: 'bitboom/thor' }, event: 'workflow_dispatch', head_branch: 'main', path: '.github/workflows/windows-release.yml', name: 'Thor Windows' });
const artifacts = () => ({ artifacts: [{ id: 12345, name: 'thor-windows-x64', expired: false, size_in_bytes: 123, workflow_run: { id: 40539274541, head_sha: 'a'.repeat(40) } }] });
const provenance = () => ({ version: '0.1.0', repository: 'bitboom/thor', source: { commit: 'a'.repeat(40), dirty: false }, runUrl: `https://github.com/bitboom/thor/actions/runs/${request().runId}`, bundle: { core: { sha256: 'c'.repeat(64), localBoundary: { schemaVersion: 1, policy: localBoundaryPolicy, passed: true, coreSha256: 'c'.repeat(64), checks: Object.fromEntries(requiredLocalBoundaryChecks.map(name => [name, true])), httpDeniedRequests: 24, wsDeniedRequests: 9 } } } });
const nativeProof = () => ({ schemaVersion: 1, policy: nativeDesktopPolicy, electronVersion: nativeDesktopElectron, modulesAbi: nativeDesktopAbi, platform: 'win32', architecture: 'x64', installedSmoke: true, packagedSmoke: true, rebuild: { name: '@electron/rebuild', version: '4.0.4', sourceBuild: true, runtimeAbiVerified: true }, sqlite: { name: 'better-sqlite3', version: '12.8.0', file: sqliteNativeFile, sha256: '1'.repeat(64), persistence: true }, additionalNativeFiles: [] });

test('release request binds one exact full source SHA, successful run ID and stable version', () => {
  assert.deepEqual(validateRequest(request()), request());
  assert.equal(validateRun(run(), request()).id, request().runId);
  assert.equal(selectArtifact(artifacts(), request()).name, 'thor-windows-x64');
});

for (const [label, mutate] of [
  ['abbreviated source', value => value.sourceSha = 'abc123'],
  ['unsafe run id', value => value.runId = '12; execute'],
  ['missing run id', value => delete value.runId],
  ['unexpected command', value => value.command = 'publish'],
  ['leading-zero version', value => value.version = '01.1.0'],
  ['non-stable version', value => value.version = '0.1.0-beta'],
]) test(`rejects release request with ${label}`, () => {
  const value = request(); mutate(value);
  assert.throws(() => validateRequest(value));
});

test('any historical successful build without current boundary evidence is rejected', () => {
  const wanted = { ...request(), sourceSha: 'b'.repeat(40) };
  const value = provenance();
  value.source.commit = wanted.sourceSha;
  delete value.bundle.core.localBoundary;
  assert.doesNotThrow(() => validateRequest(wanted));
  assert.throws(() => validateProvenance(value, wanted), /local-boundary evidence/);
});

for (const [label, mutate] of [
  ['different source', value => value.head_sha = 'b'.repeat(40)],
  ['failed build', value => value.conclusion = 'failure'],
  ['unfinished build', value => value.status = 'in_progress'],
  ['pull request build', value => value.event = 'pull_request'],
  ['fork source', value => value.head_repository.full_name = 'another/thor'],
  ['another workflow', value => value.path = '.github/workflows/seed-bootstrap.yml'],
  ['non-main source', value => value.head_branch = 'feature'],
]) test(`rejects artifact provenance from ${label}`, () => {
  const value = run(); mutate(value);
  assert.throws(() => validateRun(value, request()));
});

test('rejects missing, expired, duplicated or source-mismatched artifacts', () => {
  assert.throws(() => selectArtifact({ artifacts: [] }, request()), /Exactly one/);
  const expired = artifacts(); expired.artifacts[0].expired = true;
  assert.throws(() => selectArtifact(expired, request()), /unexpired/);
  const duplicate = artifacts(); duplicate.artifacts.push(duplicate.artifacts[0]);
  assert.throws(() => selectArtifact(duplicate, request()), /Exactly one/);
  const wrongSource = artifacts(); wrongSource.artifacts[0].workflow_run.head_sha = 'b'.repeat(40);
  assert.throws(() => selectArtifact(wrongSource, request()), /requested source run/);
});

test('downloaded build must identify the exact requested Windows run as well as source/version', () => {
  const value = provenance();
  value.desktopNative = nativeProof();
  assert.doesNotThrow(() => validateProvenance(value, request()));
  value.runUrl = 'https://github.com/bitboom/thor/actions/runs/42';
  assert.throws(() => validateProvenance(value, request()), /reviewed release request/);
});

test('current controller requires packaged Electron native ABI proof before accepting the build', () => {
  const value = provenance();
  assert.throws(() => validateProvenance(value, request()), /native ABI smoke proof/);
  value.desktopNative = nativeProof();
  assert.doesNotThrow(() => validateProvenance(value, request()));
  value.desktopNative.modulesAbi = '137';
  assert.throws(() => validateProvenance(value, request()), /native ABI smoke proof/);
});

for (const [label, mutate] of [
  ['old schema', core => core.localBoundary.schemaVersion = 0],
  ['old policy', core => core.localBoundary.policy = 'older-policy'],
  ['different Core bytes', core => core.sha256 = 'd'.repeat(64)],
  ['failed proof', core => core.localBoundary.passed = false],
  ['missing HTTP protection', core => core.localBoundary.checks.httpForeignHostRejected = false],
  ['missing WS protection', core => delete core.localBoundary.checks.wsForeignOriginRejected],
  ['incomplete negative count', core => core.localBoundary.httpDeniedRequests = 0],
]) test(`current controller rejects ${label} independently of source verifier`, () => {
  const value = provenance(); mutate(value.bundle.core);
  assert.throws(() => validateProvenance(value, request()), /local-boundary|Local-boundary/);
});

test('public latest cannot move backwards or overwrite an existing version', () => {
  assert.doesNotThrow(() => requireNewVersion('0.1.0', null));
  assert.doesNotThrow(() => requireNewVersion('0.1.1', 'v0.1.0'));
  assert.throws(() => requireNewVersion('0.1.0', 'v0.1.0'), /newer/);
  assert.throws(() => requireNewVersion('0.1.0', 'v0.2.0'), /newer/);
  assert.throws(() => requireNewVersion('0.1.0', 'unrecognized'), /unrecognized/);
});

test('current controller rejects an old artifact before running source code or creating a tag', t => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'thor-controller-order-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const control = path.join(fixture, 'release/control');
  mkdirSync(control, { recursive: true });
  for (const file of ['run.mjs', 'contract.mjs']) copyFileSync(fileURLToPath(new URL(file, import.meta.url)), path.join(control, file));
  copyFileSync(fileURLToPath(new URL('../local-boundary-policy.mjs', import.meta.url)), path.join(fixture, 'release/local-boundary-policy.mjs'));
  copyFileSync(fileURLToPath(new URL('../native-policy.mjs', import.meta.url)), path.join(fixture, 'release/native-policy.mjs'));
  writeFileSync(path.join(fixture, 'release/release-request.json'), JSON.stringify(request()));
  const old = provenance(); delete old.bundle.core.localBoundary;
  const capture = path.join(fixture, 'calls.json');
  const hook = path.join(fixture, 'mock-github.mjs');
  // All remote/process effects are intercepted. The artifact deliberately has
  // a formerly valid source/run identity but no current boundary evidence.
  writeFileSync(hook, `
import cp from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const calls=[]; const record=value=>{calls.push(value);writeFileSync(${JSON.stringify(capture)},JSON.stringify(calls));};
globalThis.fetch=async url=>{
 const route=new URL(url).pathname.split('/repos/bitboom/thor/')[1]; record({api:route});
 let value=null;let status=200;
 if(route==='git/ref/heads/main') value={object:{sha:'e'.repeat(40)}};
 else if(route==='actions/runs/${request().runId}') value=${JSON.stringify(run())};
 else if(route==='actions/runs/${request().runId}/artifacts') value=${JSON.stringify(artifacts())};
 else if(route==='releases/latest'||route.startsWith('git/ref/tags/')||route.startsWith('releases/tags/')) status=404;
 else throw new Error('Unexpected API mutation');
 return {ok:status===200,status,json:async()=>value};
};
cp.execFileSync=(command,args)=>{
 record({command,args});
 if(command==='git'&&args[0]==='init'){
  const source=args[1];mkdirSync(path.join(source,'desktop/aionui'),{recursive:true});
  for(const file of ['package.json','desktop/aionui/package.json'])writeFileSync(path.join(source,file),'${JSON.stringify({ version: '0.1.0' })}');
 }else if(command==='git'&&args.includes('rev-parse'))return 'a'.repeat(40)+'\\n';
 else if(command==='gh')writeFileSync(path.join(args.at(-1),'thor-build.json'),${JSON.stringify(JSON.stringify(old))});
 else if(command!=='git')throw new Error('Historical source execution attempted');
 return Buffer.alloc(0);
};
syncBuiltinESMExports();
`);
  assert.throws(() => execFileSync(process.execPath, [path.join(control, 'run.mjs')], {
    cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GITHUB_REPOSITORY: 'bitboom/thor', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'e'.repeat(40), GH_TOKEN: 'synthetic-fixture-token', NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` },
  }), /current local-boundary evidence/);
  const calls = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(calls.some(call => call.command === 'npm' || call.command === process.execPath || call.api === 'git/refs'), false);
  assert.equal(calls.some(call => call.command === 'gh'), true);
});
