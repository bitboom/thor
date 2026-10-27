import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { root, readJson, digest, describeFile, validateUpdateManifest, verifyRelease } from './artifact-lib.mjs';

const version = '0.1.0';
const installer = Buffer.from('MZ synthetic installer fixture');
const file = `Thor-${version}-win-x64.exe`;
const metadata = () => ({ version, files: [{ url: file, size: installer.length, sha512: digest(installer, 'sha512', 'base64') }], path: file, sha512: digest(installer, 'sha512', 'base64') });

test('accepts matching updater bytes and exact release version', () => {
  assert.equal(validateUpdateManifest(metadata(), { version, installer, tag: `v${version}` }), file);
});

for (const [name, mutate, expected] of [
  ['modified installer', value => value.files[0].sha512 = 'tampered', /SHA512/],
  ['modified legacy updater hash', value => value.sha512 = 'tampered', /SHA512/],
  ['incorrect size', value => value.files[0].size += 1, /size mismatch/],
  ['incorrect version', value => value.version = '0.1.1', /version/],
  ['unexpected name', value => value.files[0].url = 'AionUi-0.1.0-win-x64.exe', /Unexpected release file/],
  ['traversing update URL', value => value.files[0].url = `../${file}`, /Unexpected release file/],
  ['absolute update URL', value => value.files[0].url = `https://example.invalid/${file}`, /Unexpected release file/],
  ['traversing legacy path', value => value.path = `../${file}`, /Unexpected release file/],
  ['extra update file', value => value.files.push(value.files[0]), /Unexpected release file/],
]) {
  test(`rejects ${name}`, () => {
    const value = metadata();
    mutate(value);
    assert.throws(() => validateUpdateManifest(value, { version, installer }), expected);
  });
}

test('rejects a tag for a different package version', () => {
  assert.throws(() => validateUpdateManifest(metadata(), { version, installer, tag: 'v0.1.1' }), /tag/);
});

function releaseFixture(t) {
  const output = mkdtempSync(path.join(tmpdir(), 'thor-release-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const upstream = readJson(path.join(root, 'upstream.lock.json'));
  const office = readJson(path.join(root, upstream.officeCliLock));
  const pin = office.assets.find(asset => asset.runtimeKey === 'win32-x64');
  const officeSource = readJson(path.join(root, upstream.officeCliSourceLock));
  const source = { commit: 'a'.repeat(40), dirty: false, sha256: 'b'.repeat(64) };
  const provenance = {
    schemaVersion: 1, version, repository: 'bitboom/thor', source,
    platform: 'windows-x64', authenticode: 'unsigned-preview', upstream,
    bundle: {
      schemaVersion: 1, runtimeKey: 'win32-x64',
      core: { file: 'aioncore.exe', size: 2, sha256: 'c'.repeat(64), source: 'host/aioncore', officeCliLockSha256: 'f'.repeat(64) },
      node: { file: `managed-resources/node/node-v${upstream.managedNode.version}-win-x64/node.exe`, version: upstream.managedNode.version, sha256: upstream.managedNode.executableSha256, archiveSha256: upstream.managedNode.sha256 },
      officeCli: { file: `managed-resources/officecli/${office.version}/${pin.name}`, version: office.version, sha256: 'e'.repeat(64), size: pin.size, readOnlyWatch: true, lockSha256: 'f'.repeat(64), source: { repository: officeSource.repository, commit: officeSource.commit, patchSha256: officeSource.patch.sha256, policy: officeSource.policy, sdkVersion: officeSource.sdkVersion } },
      managedResourcesSha256: 'd'.repeat(64),
    },
    tools: { githubCli: { file: 'tools/gh.exe', version: upstream.githubCli.version, sha256: upstream.githubCli.executableSha256, archiveSha256: upstream.githubCli.sha256 } },
    hub: { commit: upstream.hub.commit, indexSha256: upstream.hub.indexSha256, extensions: [] },
  };
  writeFileSync(path.join(output, file), installer);
  writeFileSync(path.join(output, 'latest.yml'), yaml.dump(metadata()));
  writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), 'Synthetic notice fixture.');
  const records = [file, 'latest.yml', 'THIRD_PARTY_NOTICES.txt'].sort();
  provenance.artifacts = records.map(name => describeFile(output, name));
  const write = () => {
    writeFileSync(path.join(output, 'thor-build.json'), JSON.stringify(provenance));
    writeFileSync(path.join(output, 'SHA256SUMS.txt'), [...records, 'thor-build.json'].sort().map(name => `${describeFile(output, name).sha256}  ${name}`).join('\n') + '\n');
  };
  write();
  return { output, upstream, provenance, write, verify: () => verifyRelease({ output, version, upstream, tag: `v${version}`, commit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) }) };
}

test('verifies release checksums without rewriting them', t => {
  const fixture = releaseFixture(t);
  const before = readFileSync(path.join(fixture.output, 'SHA256SUMS.txt'));
  assert.equal(fixture.verify().installer, file);
  assert.deepEqual(readFileSync(path.join(fixture.output, 'SHA256SUMS.txt')), before);
});

test('rejects altered installer bytes after metadata generation', t => {
  const fixture = releaseFixture(t);
  writeFileSync(path.join(fixture.output, file), Buffer.from('MZ altered installer fixture'));
  assert.throws(fixture.verify, /SHA512/);
});

test('rejects tampered public checksums', t => {
  const fixture = releaseFixture(t);
  writeFileSync(path.join(fixture.output, 'SHA256SUMS.txt'), '0'.repeat(64) + `  ${file}\n`);
  assert.throws(fixture.verify, /SHA256SUMS/);
});

test('rejects notices changed after provenance was recorded', t => {
  const fixture = releaseFixture(t);
  writeFileSync(path.join(fixture.output, 'THIRD_PARTY_NOTICES.txt'), 'Changed notice fixture.');
  assert.throws(fixture.verify, /Artifact hash or size mismatch/);
});

test('rejects a bundled OfficeCLI version different from the pin', t => {
  const fixture = releaseFixture(t);
  fixture.provenance.bundle.officeCli.version = 'v0.0.0';
  fixture.write();
  assert.throws(fixture.verify, /OfficeCLI provenance/);
});

test('rejects the original mutable OfficeCLI binary and missing read-only policy', t => {
  const fixture = releaseFixture(t);
  const baseline = readJson(path.join(root, fixture.upstream.officeCliLock));
  fixture.provenance.bundle.officeCli.sha256 = baseline.assets.find(asset => asset.runtimeKey === 'win32-x64').sha256;
  fixture.write();
  assert.throws(fixture.verify, /read-only source pin/);
  fixture.provenance.bundle.officeCli.sha256 = 'e'.repeat(64);
  fixture.provenance.bundle.officeCli.readOnlyWatch = false;
  fixture.write();
  assert.throws(fixture.verify, /read-only source pin/);
});

test('rejects an unreviewed OfficeCLI patch or a different lock embedded into Core', t => {
  const fixture = releaseFixture(t);
  const original = fixture.provenance.bundle.officeCli.source.patchSha256;
  fixture.provenance.bundle.officeCli.source.patchSha256 = '0'.repeat(64);
  fixture.write();
  assert.throws(fixture.verify, /read-only source pin/);
  fixture.provenance.bundle.officeCli.source.patchSha256 = original;
  fixture.provenance.bundle.core.officeCliLockSha256 = '0'.repeat(64);
  fixture.write();
  assert.throws(fixture.verify, /read-only source pin/);
});

test('rejects machine paths in bundle provenance', t => {
  const fixture = releaseFixture(t);
  fixture.provenance.bundle.core.path = 'C:\\private\\build';
  fixture.write();
  assert.throws(fixture.verify, /unsafe path/);
});

test('rejects provenance copied from another source revision', t => {
  const fixture = releaseFixture(t);
  fixture.provenance.source.commit = 'e'.repeat(40);
  fixture.write();
  assert.throws(fixture.verify, /commit/);
});

test('rejects modified checkout content and dirty workflow sources', t => {
  const fixture = releaseFixture(t);
  fixture.provenance.source.sha256 = 'e'.repeat(64);
  fixture.write();
  assert.throws(fixture.verify, /source digest/);
  fixture.provenance.source.sha256 = 'b'.repeat(64);
  fixture.provenance.source.dirty = true;
  fixture.write();
  assert.throws(fixture.verify, /not clean/);
});

test('Windows installer process ownership excludes upstream and unrelated processes', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(path.join(root, 'desktop/aionui/resources/windows/installer-process-control.nsh'), 'utf8');
  const raw = source.slice(source.indexOf('function Test-AionUiOwnedProcess'), source.indexOf('    $$hits ='));
  const helper = raw.replace(/ \\\r?\n/g, '\n').replaceAll('$$', '$').replaceAll('${AIONUI_APP_EXECUTABLE_FILENAME}', 'Thor.exe');
  const temporary = mkdtempSync(path.join(tmpdir(), 'thor-process-ownership-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const script = path.join(temporary, 'ownership.ps1');
  writeFileSync(script, `$ErrorActionPreference='Stop'\n$installerPid=99\n$ownedPrefix='C:\\Apps\\Thor\\'\n${helper}\n$paths=@('C:\\Apps\\Thor\\Thor.exe','C:\\Apps\\Thor\\resources\\bundled-aioncore\\win32-x64\\aioncore.exe','C:\\Apps\\Thor\\resources\\thor-release\\tools\\gh.exe','C:\\Apps\\AionUi\\AionUi.exe','C:\\Apps\\Thor\\AionUi.exe','C:\\Apps\\Thor\\other.exe','C:\\Apps\\Thor-old\\Thor.exe')\n@($paths | ForEach-Object { Test-AionUiOwnedProcess ([pscustomobject]@{ExecutablePath=$_;ProcessId=12}) }) | ConvertTo-Json -Compress\n`);
  const actual = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', readFileSync(script, 'utf8')], { encoding: 'utf8' }));
  assert.deepEqual(actual, [true, true, true, false, false, false, false]);
});

test('installer report compatibility script ignores a supplied endpoint and private fields', { skip: process.platform !== 'win32' }, t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'thor-private-installer-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const script = readFileSync(path.join(root, 'desktop/aionui/resources/windows/support/report-installer-failure.ps1'), 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } -Dsn 'https://example.invalid/private' -Code E1003 -Detail 'private-fixture-content' -NoUi`], { env: { ...process.env, TEMP: temporary } });
  const result = readJson(path.join(temporary, 'thor-installer-report.json'));
  assert.deepEqual(result, { schemaVersion: 1, status: 'skipped', reason: 'privacy-disabled', code: 'E1003' });
});
