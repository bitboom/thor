import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('clean CI materializes Electron before reading its distribution notices', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'thor-clean-electron-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'build-windows.mjs');
  writeFileSync(script, readFileSync(new URL('./build-windows.mjs', import.meta.url)));
  const capture = path.join(directory, 'calls.json');
  const artifact = path.join(directory, 'artifact-fixture.mjs');
  writeFileSync(artifact, `export const root=${JSON.stringify(directory)};
export function readJson(file){return file.endsWith('bundle-provenance.json')?{core:{file:'core',sha256:'a'},node:{file:'node',sha256:'a'},officeCli:{file:'office',sha256:'a'},managedResourcesSha256:'b'}:{version:'0.1.0'};}
export const describeFile=()=>({sha256:'a'}),treeDigest=()=> 'b',digest=()=> '',readUpdateManifest=()=>({}),validateUpdateManifest=()=>{},validateBundleProvenance=()=>{},verifyRelease=()=>{};
`);
  const stage = path.join(directory, 'stage-fixture.mjs');
  writeFileSync(stage, `import{readdirSync,readFileSync,writeFileSync}from'node:fs';import path from'node:path';
export const sourceProvenance=()=>({commit:'a'.repeat(40),dirty:false});
export function stageResources(){
 readdirSync(path.join(${JSON.stringify(directory)},'node_modules/electron/dist'));
 const calls=JSON.parse(readFileSync(${JSON.stringify(capture)},'utf8'));calls.push('stage notices');writeFileSync(${JSON.stringify(capture)},JSON.stringify(calls));
 throw Error('STOP_AFTER_VERIFIED_PREPARATION');
}
`);
  const signature = path.join(directory, 'signature-fixture.mjs');
  writeFileSync(signature, `export function assertUnsignedInstaller(){throw Error('Signature must be checked after installer creation');}`);
  const hook = path.join(directory, 'isolated-prepare-hook.mjs');
  writeFileSync(hook, `import cp from'node:child_process';import{registerHooks,syncBuiltinESMExports}from'node:module';import{mkdirSync,writeFileSync}from'node:fs';import{pathToFileURL}from'node:url';import path from'node:path';
Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
cp.execFileSync=(command,args)=>{
 if(command!==process.execPath||args[0]!=='release/native-desktop.mjs'||args[1]!=='rebuild')throw Error('Unexpected build side effect');
 mkdirSync(path.join(${JSON.stringify(directory)},'node_modules/electron/dist'),{recursive:true});
 writeFileSync(${JSON.stringify(capture)},JSON.stringify(['native preparation']));return Buffer.alloc(0);
};syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===pathToFileURL(${JSON.stringify(script)}).href){
  if(specifier==='./artifact-lib.mjs')return{url:pathToFileURL(${JSON.stringify(artifact)}).href,shortCircuit:true};
  if(specifier==='./stage-resources.mjs')return{url:pathToFileURL(${JSON.stringify(stage)}).href,shortCircuit:true};
  if(specifier==='./authenticode.mjs')return{url:pathToFileURL(${JSON.stringify(signature)}).href,shortCircuit:true};
 }return next(specifier,context);
}});
`);
  assert.throws(() => execFileSync(process.execPath, [script], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, THOR_REUSE_VERIFIED_HOST: '1', GITHUB_REF_TYPE: 'branch', NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` },
  }), /STOP_AFTER_VERIFIED_PREPARATION/);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['native preparation', 'stage notices']);
});
