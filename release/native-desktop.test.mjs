import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { nativeDesktopPolicy, nativeDesktopElectron, nativeDesktopAbi, sqliteNativeFile, validateNativeDesktopProof } from './native-policy.mjs';

const fixture = () => ({ schemaVersion: 1, policy: nativeDesktopPolicy, electronVersion: nativeDesktopElectron, modulesAbi: nativeDesktopAbi, platform: 'win32', architecture: 'x64', installedSmoke: true, packagedSmoke: true, rebuild: { name: '@electron/rebuild', version: '4.0.4', sourceBuild: true, runtimeAbiVerified: true }, sqlite: { name: 'better-sqlite3', version: '12.8.0', file: sqliteNativeFile, sha256: 'a'.repeat(64), persistence: true }, additionalNativeFiles: [] });

test('native policy accepts both load and close/reopen persistence evidence for the pinned Electron ABI', () => {
  assert.equal(validateNativeDesktopProof(fixture(), nativeDesktopElectron).modulesAbi, '148');
});

for (const [name, mutate] of [
  ['Node ABI instead of Electron ABI', value => value.modulesAbi = '137'],
  ['older Electron version', value => value.electronVersion = '37.10.3'],
  ['missing rebuild tool', value => delete value.rebuild],
  ['an unverified ABI override', value => value.rebuild.runtimeAbiVerified = false],
  ['missing installed smoke', value => value.installedSmoke = false],
  ['missing packaged smoke', value => value.packagedSmoke = false],
  ['missing persistence', value => value.sqlite.persistence = false],
  ['missing binary hash', value => delete value.sqlite.sha256],
  ['an unchecked additional native module', value => value.additionalNativeFiles.push({ file: 'node_modules/addon/index.node', sha256: 'b'.repeat(64), loaded: false })],
  ['a traversing native module path', value => value.additionalNativeFiles.push({ file: 'node_modules/../private.node', sha256: 'b'.repeat(64), loaded: true })],
]) test(`native policy rejects ${name}`, () => {
  const value = fixture(); mutate(value);
  assert.throws(() => validateNativeDesktopProof(value, nativeDesktopElectron));
});

test('Thor afterPack invokes the packaged native smoke and propagates its failure before legacy rebuilds', async () => {
  const file = fileURLToPath(new URL('../desktop/aionui/scripts/afterPack.js', import.meta.url));
  const calls = [];
  const module = { exports: {} };
  const requireFixture = name => {
    if (name === 'builder-util') return { Arch: { 1: 'x64' } };
    if (name === 'path') return path;
    if (name === 'os') return { arch: () => 'x64' };
    if (name === 'fs') return { existsSync: directory => directory.endsWith('resources'), readdirSync: () => [] };
    if (name === './rebuildNativeModules') return { normalizeArch: value => value, getModulesToRebuild: () => { throw new Error('Unpinned legacy rebuild must not execute'); } };
    if (name.includes('verify-bundled-aioncore-resources')) return { verifyBundledAioncoreResources: () => ({ missing: [], checked: [], runtimeKey: 'win32-x64' }) };
    if (name === 'node:child_process') return { execFileSync: (...args) => { calls.push(args); throw new Error('Synthetic packaged ABI failure'); } };
    throw new Error(`Unexpected fixture dependency: ${name}`);
  };
  const wrapper = vm.runInNewContext(`(function(require,module,__dirname,process,console){${readFileSync(file, 'utf8')}\n})`);
  wrapper(requireFixture, module, path.dirname(file), { env: { AIONUI_THOR_RELEASE: '1' }, execPath: process.execPath }, { log() {}, warn() {}, error() {} });
  const output = path.resolve('synthetic-thor-app');
  await assert.rejects(module.exports({ arch: 'x64', electronPlatformName: 'win32', appOutDir: output }), /Synthetic packaged ABI failure/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(Array.from(calls[0][1]), [fileURLToPath(new URL('./native-desktop.mjs', import.meta.url)), 'verify-packaged', output]);
});
