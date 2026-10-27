import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { repository, artifactName, validateRequest, validateRun, selectArtifact, validateProvenance, requireNewVersion } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') || !process.env.GH_TOKEN) throw new Error('Release control requires the reviewed main-push GitHub Actions context.');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const request = validateRequest(readJson(path.join(root, 'release/release-request.json')));
const tag = `v${request.version}`;
const token = process.env.GH_TOKEN;
async function api(route, { optional = false, body } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release-control request failed with HTTP ${response.status}.`);
  return response.json();
}
const assertRequestIsCurrent = async () => {
  const current = await api('git/ref/heads/main');
  if (current.object?.sha !== process.env.GITHUB_SHA) throw new Error('main moved after the release request; no tag or release will be created.');
};
await assertRequestIsCurrent();
validateRun(await api(`actions/runs/${request.runId}`), request);
selectArtifact(await api(`actions/runs/${request.runId}/artifacts?per_page=100`), request);
requireNewVersion(request.version, (await api('releases/latest', { optional: true }))?.tag_name ?? null);
if (await api(`git/ref/tags/${tag}`, { optional: true })) throw new Error('Release tag already exists; tags are never overwritten.');
if (await api(`releases/tags/${tag}`, { optional: true })) throw new Error('Release already exists; release assets are never overwritten.');

const work = path.join(root, '.thor-local/release-control', `${process.env.GITHUB_RUN_ID || 'run'}-${randomUUID()}`);
const source = path.join(work, 'source');
const artifacts = path.join(work, 'artifacts');
mkdirSync(source, { recursive: true });
mkdirSync(artifacts, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
run('git', ['init', source]);
run('git', ['-C', source, 'remote', 'add', 'origin', `https://github.com/${repository}.git`]);
run('git', ['-C', source, 'fetch', '--depth=1', 'origin', request.sourceSha]);
run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
const checkedOut = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (checkedOut !== request.sourceSha) throw new Error('Tested source checkout does not match the release request.');
if (readJson(path.join(source, 'package.json')).version !== request.version || readJson(path.join(source, 'desktop/aionui/package.json')).version !== request.version) throw new Error('Tested source version does not match the release request.');
run('gh', ['run', 'download', String(request.runId), '--repo', repository, '--name', artifactName, '--dir', artifacts]);
validateProvenance(readJson(path.join(artifacts, 'thor-build.json')), request);
run('npm', ['ci', '--ignore-scripts'], { cwd: source });
const releaseEnvironment = { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_SHA: request.sourceSha, GITHUB_REF: `refs/tags/${tag}`, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' };
// Use the verifier and publisher from the source revision that produced the
// successful artifact, including its canonical source-digest computation.
run(process.execPath, ['release/verify-artifacts.mjs', artifacts], { cwd: source, env: releaseEnvironment });
await assertRequestIsCurrent();
const created = await api('git/refs', { body: { ref: `refs/tags/${tag}`, sha: request.sourceSha } });
if (created.ref !== `refs/tags/${tag}` || created.object?.sha !== request.sourceSha) throw new Error('Created release tag did not match the tested source.');
run(process.execPath, ['release/write-notes.mjs'], { cwd: source, env: releaseEnvironment });
run(process.execPath, ['release/publish.mjs', artifacts], { cwd: source, env: releaseEnvironment });
console.log(JSON.stringify({ published: true, tag, sourceSha: request.sourceSha, windowsRunId: request.runId, reusedExistingArtifact: true }));
