import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateCoreBoundaryProof } from './local-boundary-policy.mjs';
import { validateNativeDesktopProof } from './native-policy.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const yaml = requireRoot('js-yaml');

export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function describeFile(directory, file) {
  if (!safeRelativePath(file)) throw new Error('Unsafe artifact path.');
  const bytes = readFileSync(path.join(directory, file));
  return { file, size: bytes.length, sha256: digest(bytes), sha512: digest(bytes, 'sha512', 'base64') };
}

export function safeRelativePath(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.\-/]+$/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

export function treeDigest(directory) {
  const records = [];
  const visit = relative => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) records.push(describeFile(directory, file));
      else throw new Error('Symlinks and special files are forbidden in managed release resources.');
    }
  };
  visit('');
  return digest(JSON.stringify(records));
}

export function validateUpdateManifest(metadata, { version, installer, tag = null }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version.');
  if (metadata?.version !== version) throw new Error('Updater version does not match package.');
  if (tag && tag !== `v${version}`) throw new Error('Release tag does not match package version.');
  const expectedName = `Thor-${version}-win-x64.exe`;
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1 || metadata.files[0]?.url !== expectedName || metadata.path !== expectedName) {
    throw new Error('Unexpected release file or update URL.');
  }
  if (installer.length < 2 || installer[0] !== 0x4d || installer[1] !== 0x5a) throw new Error('Installer is not a Windows executable.');
  const sha512 = digest(installer, 'sha512', 'base64');
  if (metadata.files[0].sha512 !== sha512 || metadata.sha512 !== sha512) throw new Error('Updater SHA512 does not match installer bytes.');
  if (!Number.isSafeInteger(metadata.files[0].size) || metadata.files[0].size !== installer.length) throw new Error('Installer size mismatch.');
  return expectedName;
}

export function readUpdateManifest(output) {
  return yaml.load(readFileSync(path.join(output, 'latest.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA });
}

export function validateBundleProvenance(bundle, upstream) {
  const office = readJson(path.join(root, upstream.officeCliLock));
  const pinnedOffice = office.assets.find(asset => asset.runtimeKey === 'win32-x64');
  const source = readJson(path.join(root, upstream.officeCliSourceLock));
  const expectedSource = { repository: source.repository, commit: source.commit, patchSha256: source.patch.sha256, policy: source.policy, sdkVersion: source.sdkVersion };
  if (bundle?.schemaVersion !== 1 || bundle.runtimeKey !== 'win32-x64' || bundle.core?.source !== 'host/aioncore') throw new Error('Invalid bundle provenance.');
  if (!/^[a-f0-9]{64}$/.test(bundle.core.sha256) || !/^[a-f0-9]{64}$/.test(bundle.managedResourcesSha256)) throw new Error('Invalid bundled Core digest.');
  validateCoreBoundaryProof(bundle.core.localBoundary, bundle.core.sha256);
  if (bundle.node?.version !== upstream.managedNode.version || bundle.node.sha256 !== upstream.managedNode.executableSha256 || bundle.node.archiveSha256 !== upstream.managedNode.sha256) throw new Error('Bundled Node provenance does not match pin.');
  if (bundle.officeCli?.version !== office.version || bundle.officeCli.readOnlyWatch !== true || !/^[a-f0-9]{64}$/.test(bundle.officeCli.sha256) || bundle.officeCli.sha256 === pinnedOffice.sha256 || !Number.isSafeInteger(bundle.officeCli.size) || bundle.officeCli.size < 1_000_000 || bundle.officeCli.size > 256 * 1024 * 1024 || JSON.stringify(bundle.officeCli.source) !== JSON.stringify(expectedSource) || !/^[a-f0-9]{64}$/.test(bundle.officeCli.lockSha256) || bundle.core.officeCliLockSha256 !== bundle.officeCli.lockSha256) throw new Error('Bundled OfficeCLI provenance does not match the read-only source pin.');
  if (bundle.core.file !== 'aioncore.exe' || bundle.node.file !== `managed-resources/node/node-v${upstream.managedNode.version}-win-x64/node.exe` || bundle.officeCli.file !== `managed-resources/officecli/${office.version}/${pinnedOffice.name}`) throw new Error('Bundled runtime path does not match the source pin.');
  for (const component of [bundle.core, bundle.node, bundle.officeCli]) {
    if (!safeRelativePath(component.file) || Object.hasOwn(component, 'path')) throw new Error('Bundle provenance contains an unsafe path.');
  }
  return bundle;
}

export function verifyRelease({ output, version, upstream, tag = null, commit = null, sourceSha256 = null }) {
  const name = `Thor-${version}-win-x64.exe`;
  const installer = readFileSync(path.join(output, name));
  validateUpdateManifest(readUpdateManifest(output), { version, installer, tag });
  const provenance = readJson(path.join(output, 'thor-build.json'));
  if (provenance.schemaVersion !== 1 || provenance.version !== version || provenance.repository !== 'bitboom/thor' || provenance.platform !== 'windows-x64' || provenance.authenticode !== 'unsigned-preview') throw new Error('Invalid build provenance.');
  if (commit && provenance.source?.commit !== commit) throw new Error('Provenance commit does not match workflow.');
  if (commit && provenance.source?.dirty !== false) throw new Error('Workflow release source is not clean.');
  if (!/^[a-f0-9]{64}$/.test(provenance.source?.sha256)) throw new Error('Missing source digest.');
  if (sourceSha256 && provenance.source.sha256 !== sourceSha256) throw new Error('Provenance source digest does not match checkout.');
  if (JSON.stringify(provenance.upstream) !== JSON.stringify(upstream)) throw new Error('Build provenance does not match source lock.');
  validateBundleProvenance(provenance.bundle, upstream);
  validateNativeDesktopProof(provenance.desktopNative, readJson(path.join(root, 'desktop/aionui/package.json')).devDependencies.electron);
  if (provenance.tools?.githubCli?.version !== upstream.githubCli.version || provenance.tools.githubCli.sha256 !== upstream.githubCli.executableSha256 || provenance.tools.githubCli.archiveSha256 !== upstream.githubCli.sha256 || provenance.tools.githubCli.file !== 'tools/gh.exe') throw new Error('Bundled GitHub CLI provenance does not match pin.');
  if (provenance.hub?.commit !== upstream.hub.commit || provenance.hub.indexSha256 !== upstream.hub.indexSha256 || !Array.isArray(provenance.hub.extensions)) throw new Error('Bundled hub provenance does not match pin.');
  if (provenance.source?.path || provenance.bundle?.source?.path) throw new Error('Build provenance contains a machine path.');
  const required = [name, 'latest.yml', 'THIRD_PARTY_NOTICES.txt'];
  const optional = `${name}.blockmap`;
  const expected = [...required, ...(provenance.artifacts?.some(record => record.file === optional) ? [optional] : [])].sort();
  if (!Array.isArray(provenance.artifacts) || JSON.stringify(provenance.artifacts.map(record => record.file).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected provenance artifact list.');
  for (const record of provenance.artifacts) {
    const actual = describeFile(output, record.file);
    if (JSON.stringify(actual) !== JSON.stringify(record)) throw new Error(`Artifact hash or size mismatch: ${record.file}`);
  }
  const checksummed = [...expected, 'thor-build.json'].sort();
  const actualSums = readFileSync(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  const expectedSums = checksummed.map(file => `${describeFile(output, file).sha256}  ${file}`).join('\n') + '\n';
  if (actualSums !== expectedSums) throw new Error('SHA256SUMS does not match release bytes.');
  for (const file of checksummed) if (!statSync(path.join(output, file)).isFile()) throw new Error('Release artifact is not a regular file.');
  return { installer: name, provenance, files: [...checksummed, 'SHA256SUMS.txt'] };
}
