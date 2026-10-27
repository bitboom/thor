import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, readJson, describeFile, digest, treeDigest, validateBundleProvenance } from './artifact-lib.mjs';
import { downloadVerifiedFile } from '../agent/tools/prepare-officecli.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Thor release builds require Windows x64.');
const lock = readJson(path.join(root, 'upstream.lock.json'));
const work = path.join(root, '.thor-local/release');
const bundle = path.join(work, 'bundle');
mkdirSync(work, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function resetDirectory(directory) {
  const relative = path.relative(work, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to clean outside release work directory.');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

async function prepareArchive(pin, directory) {
  const downloads = path.join(work, 'downloads');
  mkdirSync(downloads, { recursive: true });
  const archive = path.join(downloads, pin.archive);
  console.log(`Preparing pinned ${pin.archive}`);
  await downloadVerifiedFile({ url: pin.url, filePath: archive, sha256: pin.sha256, size: pin.size, maxBytes: pin.size || 128 * 1024 * 1024 });
  resetDirectory(directory);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(directory)} -Force`]);
}

const officeStage = path.join(work, 'officecli-source');
run(process.execPath, ['release/officecli-source.mjs', '--output', officeStage]);
const officeLockPath = path.join(officeStage, 'effective-lock.json');
const officeLockSha256 = digest(readFileSync(officeLockPath));
const office = readJson(officeLockPath);
const officeAsset = office.assets.find(asset => asset.runtimeKey === 'win32-x64');
if (officeAsset?.readOnlyWatch !== true) throw new Error('OfficeCLI source build did not enable the read-only watch policy.');
console.log('Building modified host/aioncore from the checked out Thor source.');
const encodedFlags = ['-C', 'target-feature=+crt-static', '--remap-path-prefix', `${root}=thor`];
const cargoHome = process.env.CARGO_HOME || path.join(process.env.USERPROFILE, '.cargo');
encodedFlags.push('--remap-path-prefix', `${cargoHome}=cargo`);
run('cargo', ['build', '--locked', '--release', '--target', 'x86_64-pc-windows-msvc', '-p', 'aionui-app', '--bin', 'aioncore'], {
  cwd: path.join(root, 'host/aioncore'),
  env: { ...process.env, THOR_OFFICECLI_LOCK_PATH: officeLockPath, CARGO_ENCODED_RUSTFLAGS: encodedFlags.join('\u001f') },
});
resetDirectory(bundle);
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, 'host/aioncore', process.env.CARGO_TARGET_DIR)
  : path.join(root, 'host/aioncore/target');
copyFileSync(path.join(cargoTarget, 'x86_64-pc-windows-msvc/release/aioncore.exe'), path.join(bundle, 'aioncore.exe'));

const nodeExtract = path.join(work, 'node-extract');
await prepareArchive(lock.managedNode, nodeExtract);
const nodeDirectory = `node-v${lock.managedNode.version}-win-x64`;
const managed = path.join(bundle, 'managed-resources');
mkdirSync(path.join(managed, 'node'), { recursive: true });
cpSync(path.join(nodeExtract, nodeDirectory), path.join(managed, 'node', nodeDirectory), { recursive: true });
const node = describeFile(bundle, `managed-resources/node/${nodeDirectory}/node.exe`);
if (node.sha256 !== lock.managedNode.executableSha256) throw new Error('Managed Node executable checksum mismatch.');
const nodeVersion = execFileSync(path.join(bundle, node.file), ['--version'], { encoding: 'utf8' }).trim();
if (nodeVersion !== `v${lock.managedNode.version}`) throw new Error('Managed Node version mismatch.');
writeFileSync(path.join(managed, 'manifest.json'), JSON.stringify({
  schemaVersion: 2, runtimeKey: 'win32-x64',
  node: { version: lock.managedNode.version, root: `node/${nodeDirectory}`, executable: 'node.exe' }, clis: [],
}, null, 2) + '\n');

cpSync(path.join(officeStage, 'managed-resources/officecli'), path.join(managed, 'officecli'), { recursive: true });
copyFileSync(officeLockPath, path.join(managed, 'officecli/manifest.json'));
const officeFile = describeFile(bundle, `managed-resources/officecli/${office.version}/${officeAsset.name}`);
if (officeFile.sha256 !== officeAsset.sha256 || officeFile.size !== officeAsset.size) throw new Error('OfficeCLI executable checksum mismatch.');
mkdirSync(path.join(managed, 'thor-agent/tools'), { recursive: true });
for (const file of ['memory-store.mjs', 'tools/memory.mjs']) {
  copyFileSync(path.join(root, 'agent', file), path.join(managed, 'thor-agent', file));
}
run(process.execPath, ['release/verify-officecli-readonly.mjs', '--bundle', bundle, '--lock', officeLockPath, '--workspace', path.join(work, 'readonly-watch-verification')]);

const githubExtract = path.join(work, 'github-cli');
await prepareArchive(lock.githubCli, githubExtract);
const githubCli = describeFile(githubExtract, 'bin/gh.exe');
if (githubCli.sha256 !== lock.githubCli.executableSha256) throw new Error('GitHub CLI executable checksum mismatch.');

const provenance = {
  schemaVersion: 1, runtimeKey: 'win32-x64',
  core: { ...describeFile(bundle, 'aioncore.exe'), source: 'host/aioncore', officeCliLockSha256: officeLockSha256 },
  node: { ...node, version: lock.managedNode.version, archiveSha256: lock.managedNode.sha256 },
  officeCli: { ...officeFile, version: office.version, readOnlyWatch: true, source: officeAsset.source, lockSha256: officeLockSha256 },
  managedResourcesSha256: treeDigest(managed),
};
validateBundleProvenance(provenance, lock);
writeFileSync(path.join(work, 'bundle-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
const metadata = run('cargo', ['metadata', '--locked', '--format-version', '1'], {
  cwd: path.join(root, 'host/aioncore'), stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 50 * 1024 * 1024,
});
writeFileSync(path.join(work, 'cargo-metadata.json'), metadata);
console.log('Verified source-built Core, pinned managed Node, OfficeCLI and GitHub CLI.');
