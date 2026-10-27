import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { nativeDesktopPolicy, nativeDesktopElectron, nativeDesktopAbi, sqliteNativeFile, validateNativeDesktopProof } from './native-policy.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Thor native release verification requires Windows x64.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop/aionui');
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const pkg = requireDesktop('./package.json');
const version = pkg.devDependencies.electron;
if (version !== nativeDesktopElectron || pkg.electronRebuild?.electronVersion !== version) throw new Error('Electron and native rebuild versions must match the reviewed exact pin.');
const work = path.join(root, '.thor-local/release');
mkdirSync(work, { recursive: true });
const proofPath = path.join(work, 'native-desktop.json');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const action = process.argv[2];
const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
const requireAppBuilder = createRequire(requireBuilder.resolve('app-builder-lib'));
const rebuildEntry = requireAppBuilder.resolve('@electron/rebuild');
const rebuildPackage = JSON.parse(readFileSync(path.join(path.dirname(rebuildEntry), '../package.json'), 'utf8'));

function verifyRuntime(electron) {
  const output = execFileSync(electron, ['--eval', 'console.log(JSON.stringify({electronVersion:process.versions.electron,modulesAbi:process.versions.modules,architecture:process.arch}))'], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const actual = JSON.parse(output.trim());
  if (actual.electronVersion !== version || actual.modulesAbi !== nativeDesktopAbi || actual.architecture !== 'x64') throw new Error('Installed Electron does not match the reviewed runtime and native ABI.');
}

function smoke(electron, sqlitePackage, nativeFiles = []) {
  const directory = path.join(work, `native-smoke-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const script = path.join(directory, 'smoke.cjs');
  // Electron's Node mode never loads the app entrypoint, a user profile, UI,
  // authentication or the Core. All database bytes are invented per run.
  writeFileSync(script, `
const assert=require('node:assert/strict');
const path=require('node:path');
try {
 assert.equal(process.versions.electron,${JSON.stringify(version)});
 assert.equal(process.versions.modules,${JSON.stringify(nativeDesktopAbi)});
 assert.equal(process.arch,'x64');
 const Database=require(${JSON.stringify(sqlitePackage)});
 const file=path.join(__dirname,'synthetic.sqlite');
 let db=new Database(file);db.exec('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
 db.prepare('INSERT INTO evidence(value) VALUES (?)').run('thor-synthetic-native-abi');db.close();
 db=new Database(file);assert.equal(db.prepare('SELECT value FROM evidence WHERE id=1').get().value,'thor-synthetic-native-abi');db.close();
 for(const file of ${JSON.stringify(nativeFiles)})require(file);
 console.log(JSON.stringify({passed:true,electronVersion:process.versions.electron,modulesAbi:process.versions.modules,architecture:process.arch,persistence:true}));
} catch(error) {console.error(JSON.stringify({passed:false,stage:'electron-native-smoke',code:error.code||'ASSERTION_FAILED'}));process.exitCode=1;}
`);
  const output = execFileSync(electron, [script], { cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(output.trim());
  if (result.passed !== true || result.electronVersion !== version || result.modulesAbi !== nativeDesktopAbi || result.persistence !== true) throw new Error('Electron native ABI smoke failed.');
  return result;
}

if (action === 'rebuild' || action === 'smoke-installed') {
  const modulePackage = requireDesktop.resolve('better-sqlite3/package.json');
  const moduleRoot = path.dirname(modulePackage);
  const moduleInfo = JSON.parse(readFileSync(modulePackage, 'utf8'));
  const electron = requireDesktop('electron');
  verifyRuntime(electron);
  if (action === 'rebuild') {
    const { rebuild } = await import(pathToFileURL(rebuildEntry).href);
    // Rebuild the resolved locked module itself. This also supports Bun's
    // isolated install without scanning or downloading an unpinned bunx tool.
    // The locked node-abi table predates this Electron release. Its override
    // comes from the exact binary probe above, never a guessed Node ABI.
    let compiled = false;
    const operation = rebuild({ buildPath: moduleRoot, projectRootPath: moduleRoot, electronVersion: version, platform: 'win32', arch: 'x64', forceABI: Number(nativeDesktopAbi), force: true, buildFromSource: true, disablePreGypCopy: true, onlyModules: ['better-sqlite3'], types: ['prod', 'optional'], mode: 'sequential', useCache: false });
    operation.lifecycle.on('module-done', name => { if (name === 'better-sqlite3') compiled = true; });
    await operation;
    if (!compiled) throw new Error('Required SQLite source rebuild was skipped.');
  }
  const native = path.join(moduleRoot, 'build/Release/better_sqlite3.node');
  const nativeHash = sha256(native);
  smoke(electron, moduleRoot);
  if (sha256(native) !== nativeHash) throw new Error('SQLite binary changed during native ABI smoke.');
  const proof = { schemaVersion: 1, policy: nativeDesktopPolicy, electronVersion: version, modulesAbi: nativeDesktopAbi, platform: 'win32', architecture: 'x64', installedSmoke: true, packagedSmoke: false, rebuild: { name: '@electron/rebuild', version: rebuildPackage.version, sourceBuild: true, runtimeAbiVerified: true }, sqlite: { name: 'better-sqlite3', version: moduleInfo.version, file: sqliteNativeFile, sha256: nativeHash, persistence: true }, additionalNativeFiles: [] };
  validateNativeDesktopProof(proof, version, { packaged: false });
  // A probe of existing binaries cannot substitute for the required rebuild.
  if (action === 'rebuild') writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, action, policy: nativeDesktopPolicy, electronVersion: version, modulesAbi: nativeDesktopAbi }));
} else if (action === 'verify-packaged') {
  const appOut = process.argv[3];
  if (!appOut || !path.isAbsolute(appOut)) throw new Error('Packaged verification requires an absolute app output directory.');
  const resources = path.join(appOut, 'resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const proof = validateNativeDesktopProof(JSON.parse(readFileSync(proofPath, 'utf8')), version, { packaged: false });
  if (sha256(path.join(unpacked, sqliteNativeFile)) !== proof.sqlite.sha256) throw new Error('Packaged SQLite differs from the rebuilt and tested binary.');
  const nativeFiles = [];
  const visit = relative => {
    for (const entry of readdirSync(path.join(unpacked, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw new Error('Unexpected special file in unpacked release resources.');
      // better-sqlite3's test_extension is an SQLite extension, not a Node
      // addon. It is never loaded by the application or this Node ABI check.
      else if (file.endsWith('.node') && file !== sqliteNativeFile && path.basename(file) !== 'test_extension.node') nativeFiles.push(file);
    }
  };
  visit('node_modules');
  const appArchive = path.join(resources, 'app.asar');
  if (!existsSync(appArchive)) throw new Error('Missing packaged application archive.');
  smoke(path.join(appOut, 'Thor.exe'), path.join(appArchive, 'node_modules/better-sqlite3'), nativeFiles.map(file => path.join(unpacked, file)));
  proof.packagedSmoke = true;
  proof.additionalNativeFiles = nativeFiles.sort().map(file => ({ file, sha256: sha256(path.join(unpacked, file)), loaded: true }));
  validateNativeDesktopProof(proof, version);
  writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, action, policy: nativeDesktopPolicy, electronVersion: version, modulesAbi: nativeDesktopAbi, additionalNativeFiles: nativeFiles.length }));
} else throw new Error('Usage: node release/native-desktop.mjs rebuild|smoke-installed|verify-packaged [ABS_APP_OUTPUT]');
