import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, readJson, describeFile, digest, treeDigest, completeUpdateManifestSize, validateBundleProvenance, verifyRelease } from './artifact-lib.mjs';
import { stageResources, sourceProvenance } from './stage-resources.mjs';
import { assertUnsignedInstaller } from './authenticode.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 packaging requires Windows x64.');
const lock = readJson(path.join(root, 'upstream.lock.json'));
const pkg = readJson(path.join(root, 'desktop/aionui/package.json'));
const workspacePackage = readJson(path.join(root, 'package.json'));
if (workspacePackage.version !== pkg.version) throw new Error('Workspace and desktop versions must match.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag does not match package version.');
if (process.env.THOR_REUSE_VERIFIED_HOST !== '1') execFileSync(process.execPath, ['release/build-host.mjs'], { cwd: root, stdio: 'inherit' });
const work = path.join(root, '.thor-local/release');
const bundle = readJson(path.join(work, 'bundle-provenance.json'));
validateBundleProvenance(bundle, lock);
for (const component of [bundle.core, bundle.node, bundle.officeCli]) {
  if (describeFile(path.join(work, 'bundle'), component.file).sha256 !== component.sha256) throw new Error('Host bundle changed after verification.');
}
if (treeDigest(path.join(work, 'bundle/managed-resources')) !== bundle.managedResourcesSha256) throw new Error('Managed resources changed after verification.');
const source = sourceProvenance();
// Electron 42+ installs its binary on first require. Native preparation must
// materialize and verify that distribution before staging its license files.
execFileSync(process.execPath, ['release/native-desktop.mjs', 'rebuild'], { cwd: root, stdio: 'inherit' });
const staged = stageResources(bundle, source);
execFileSync(process.execPath, ['scripts/build-with-builder.js', 'x64', '--win', '--x64'], {
  cwd: path.join(root, 'desktop/aionui'),
  stdio: 'inherit',
  env: {
    ...process.env,
    GITHUB_SHA: source.commit,
    AIONUI_HUB_TAG: lock.hub.commit, AIONUI_HUB_SKIP: '',
    AIONUI_BACKEND_VERSION: lock.host.tag, AIONUI_THOR_RELEASE: '1',
    AIONUI_BACKEND_LOCAL_BUNDLE_DIR: path.join(work, 'bundle'),
    AIONUI_BACKEND_LOCAL_BINARY: '', AIONUI_BACKEND_RUN_ID: '',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '',
    SENTRY_DSN: '',
    IS_DISCONTINUED_BUILD: 'false',
  },
});
const output = path.join(root, 'desktop/aionui/out');
const packagedResources = path.join(output, 'win-unpacked/resources');
const packagedBundle = path.join(packagedResources, 'bundled-aioncore/win32-x64');
for (const component of [bundle.core, bundle.node, bundle.officeCli]) {
  if (describeFile(packagedBundle, component.file).sha256 !== component.sha256) throw new Error('Packaged runtime differs from the verified build.');
}
if (treeDigest(path.join(packagedBundle, 'managed-resources')) !== bundle.managedResourcesSha256) throw new Error('Packaged managed resources differ from the verified build.');
const coreManifest = readJson(path.join(packagedBundle, 'manifest.json'));
if (coreManifest.sourceType !== 'local-bundle' || coreManifest.source?.repository !== 'bitboom/thor' || coreManifest.source?.path) throw new Error('Packaged Core has unsafe or unexpected provenance.');
if (treeDigest(path.join(packagedResources, 'thor-release')) !== treeDigest(staged.resources)) throw new Error('Packaged release notices or tools are incomplete.');

const hubDirectory = path.join(packagedResources, 'hub');
const hubIndex = readJson(path.join(hubDirectory, 'index.json'));
if (digest(readFileSync(path.join(hubDirectory, 'index.json'))) !== lock.hub.indexSha256) throw new Error('Bundled hub index differs from the pinned source.');
const hubExtensions = Object.values(hubIndex.extensions).map(extension => {
  const name = extension.dist?.tarball;
  if (!name || name !== path.basename(name)) throw new Error('Invalid pinned hub artifact path.');
  const file = describeFile(hubDirectory, name);
  if (`sha512-${file.sha512}` !== extension.dist.integrity) throw new Error('Bundled hub extension integrity mismatch.');
  return file;
});
const hub = { commit: lock.hub.commit, indexSha256: lock.hub.indexSha256, extensions: hubExtensions };
copyFileSync(path.join(staged.resources, 'THIRD_PARTY_NOTICES.txt'), path.join(output, 'THIRD_PARTY_NOTICES.txt'));
const name = `Thor-${pkg.version}-win-x64.exe`;
const installer = readFileSync(path.join(output, name));
assertUnsignedInstaller(path.join(output, name));
completeUpdateManifestSize(output, { version: pkg.version, installer });
const names = [name, 'latest.yml', 'THIRD_PARTY_NOTICES.txt'];
if (existsSync(path.join(output, `${name}.blockmap`))) names.push(`${name}.blockmap`);
const provenance = {
  schemaVersion: 1, version: pkg.version, repository: 'bitboom/thor', source,
  runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/bitboom/thor/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  platform: 'windows-x64', authenticode: 'unsigned-preview', upstream: lock,
  bundle, tools: staged.tools, hub, artifacts: names.sort().map(file => describeFile(output, file)),
  desktopNative: readJson(path.join(work, 'native-desktop.json')),
};
writeFileSync(path.join(output, 'thor-build.json'), JSON.stringify(provenance, null, 2) + '\n');
writeFileSync(path.join(output, 'SHA256SUMS.txt'), [...names, 'thor-build.json'].sort().map(file => `${describeFile(output, file).sha256}  ${file}`).join('\n') + '\n');
verifyRelease({ output, version: pkg.version, upstream: lock, commit: process.env.GITHUB_SHA || null, sourceSha256: sourceProvenance().sha256 });
console.log(`Built and verified ${name}.`);
