import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedPaths, treeEntries, snapshotDigest, validateManifest, verifyPatch } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024, ...options });
const text = args => git(args, { encoding: 'utf8' }).trim();
const seed = process.env.THOR_BOOTSTRAP_SEED_SHA;
if (process.env.GITHUB_REPOSITORY !== 'bitboom/thor' || !/^[a-f0-9]{40}$/.test(seed || '') || process.env.GITHUB_SHA !== seed || !process.env.GH_TOKEN) throw new Error('Bootstrap requires the explicitly selected Thor seed commit in GitHub Actions.');
if (text(['rev-parse', 'HEAD']) !== seed || text(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Bootstrap seed checkout changed or is not clean.');
const assertRemoteSeed = () => {
  const remote = text(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (remote !== seed) throw new Error('main moved after seed review; refusing to publish reconstructed source.');
};
assertRemoteSeed();
const upstream = JSON.parse(readFileSync(path.join(root, 'upstream.lock.json'), 'utf8'));
const manifest = validateManifest(JSON.parse(readFileSync(path.join(root, 'release/bootstrap/manifest.json'), 'utf8')), upstream);
const patch = readFileSync(path.join(root, manifest.patch.file));
verifyPatch(patch, manifest.patch.sha256);
const present = ['desktop', 'host'].map(name => existsSync(path.join(root, manifest.upstream[name].directory)));
if (present.every(Boolean)) {
  console.log('Both source subtrees are already present; one-shot bootstrap has no work to do.');
  process.exit(0);
}
if (present.some(Boolean)) throw new Error('Bootstrap seed contains a partial source reconstruction.');
git(['config', 'user.name', 'github-actions[bot]']);
git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
for (const name of ['desktop', 'host']) {
  const source = manifest.upstream[name];
  git(['fetch', '--depth=1', '--no-tags', source.repository, source.commit]);
  if (text(['rev-parse', 'FETCH_HEAD']) !== source.commit) throw new Error('Fetched upstream revision differs from the source pin.');
  git(['subtree', 'add', `--prefix=${source.directory}`, source.commit, '--squash']);
}
git(['apply', '--check', '--index', '--binary', '--whitespace=nowarn', manifest.patch.file]);
git(['apply', '--index', '--binary', '--whitespace=nowarn', manifest.patch.file]);
const reconstructed = treeEntries(git(['ls-tree', '-rz', '--full-tree', text(['write-tree'])]));
if (snapshotDigest(reconstructed) !== manifest.sourceTreeSha256 || reconstructed.filter(entry => !generatedPaths.has(entry.path)).length !== manifest.sourceTreeFileCount) throw new Error('Reconstructed source differs from the reviewed canonical snapshot.');
git(['commit', '-m', 'feat(bootstrap): apply reviewed Thor integration to pinned subtrees']);
if (snapshotDigest(treeEntries(git(['ls-tree', '-rz', '--full-tree', 'HEAD']))) !== manifest.sourceTreeSha256) throw new Error('Committed bootstrap source differs from the reviewed snapshot.');
assertRemoteSeed();
git(['push', 'origin', 'HEAD:refs/heads/main']);
const source = text(['rev-parse', 'HEAD']);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${source}\n`);
// Repository-scoped GITHUB_TOKEN pushes do not trigger workflows. Explicitly
// dispatch a build of the completed source commit; this does not create a tag.
execFileSync('gh', ['workflow', 'run', 'windows-release.yml', '--repo', 'bitboom/thor', '--ref', 'main'], { cwd: root, stdio: 'inherit', env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' } });
console.log(`Published verified source ${source} and dispatched the initial Windows build. No release tag was created.`);
