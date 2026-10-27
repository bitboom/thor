import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generatedPaths, treeEntries, snapshotDigest, sha256, validateManifest, verifyPatch } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 100 * 1024 * 1024, ...options });
const exclusions = [...generatedPaths].map(file => `:(exclude)${file}`);
if (git(['status', '--porcelain', '--untracked-files=all', '--', '.', ...exclusions], { encoding: 'utf8' }).trim()) throw new Error('Commit the reviewed source and complete checks before preparing the public bootstrap snapshot.');
const sourceCommit = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const upstream = JSON.parse(readFileSync(path.join(root, 'upstream.lock.json'), 'utf8'));
const version = JSON.parse(readFileSync(path.join(root, 'desktop/aionui/package.json'), 'utf8')).version;
const entries = treeEntries(git(['ls-tree', '-rz', '--full-tree', sourceCommit]));
const work = path.join(root, '.thor-local/bootstrap');
mkdirSync(work, { recursive: true });
const temporaryIndex = path.join(work, `index-${randomUUID()}`);
let baseTree;
try {
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  git(['read-tree', '--empty'], { env });
  for (const name of ['desktop', 'host']) {
    git(['cat-file', '-e', `${upstream[name].commit}^{tree}`]);
    git(['read-tree', `--prefix=${upstream[name].directory}/`, `${upstream[name].commit}^{tree}`], { env });
  }
  baseTree = git(['write-tree'], { env, encoding: 'utf8' }).trim();
} finally {
  rmSync(temporaryIndex, { force: true });
  rmSync(`${temporaryIndex}.lock`, { force: true });
}
const patch = git(['-c', 'core.quotePath=false', 'diff', '--binary', '--full-index', baseTree, sourceCommit, '--', 'desktop/aionui', 'host/aioncore']);
const manifest = {
  schemaVersion: 1, version, preparedFromCommit: sourceCommit,
  sourceTreeSha256: snapshotDigest(entries),
  sourceTreeFileCount: entries.filter(entry => !generatedPaths.has(entry.path)).length,
  upstream: Object.fromEntries(['desktop', 'host'].map(name => [name, { repository: upstream[name].repository, commit: upstream[name].commit, directory: upstream[name].directory }])),
  patch: { file: 'release/bootstrap/integration.patch', sha256: sha256(patch) },
};
validateManifest(manifest, upstream);
verifyPatch(patch, manifest.patch.sha256);
writeFileSync(path.join(root, manifest.patch.file), patch);
writeFileSync(path.join(root, 'release/bootstrap/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const seedFiles = entries.filter(entry => !generatedPaths.has(entry.path) && !entry.path.startsWith('desktop/aionui/') && !entry.path.startsWith('host/aioncore/')).map(entry => {
  const bytes = git(['cat-file', 'blob', entry.object]);
  return { path: entry.path, mode: entry.mode, type: 'blob', encoding: 'base64', size: bytes.length, sha256: sha256(bytes), content: bytes.toString('base64') };
});
for (const file of generatedPaths) {
  const bytes = readFileSync(path.join(root, file));
  seedFiles.push({ path: file, mode: '100644', type: 'blob', encoding: 'base64', size: bytes.length, sha256: sha256(bytes), content: bytes.toString('base64') });
}
writeFileSync(path.join(work, 'seed-files.json'), JSON.stringify({ sourceTreeSha256: manifest.sourceTreeSha256, files: seedFiles }, null, 2) + '\n');
console.log(`Prepared ${seedFiles.length} seed files and a ${patch.length}-byte checked subtree patch. Canonical source SHA256: ${manifest.sourceTreeSha256}`);
console.log('Review and commit the generated manifest and patch. Upload seed-files.json entries through the authorized GitHub connector; this helper does not push.');
