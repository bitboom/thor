import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { root, readJson, readUpdateManifest, completeUpdateManifestSize, validateUpdateManifest } from './artifact-lib.mjs';

export async function updateManifestPreflight() {
  const requireDesktop = createRequire(path.join(root, 'desktop/aionui/package.json'));
  const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
  const requireApp = createRequire(requireBuilder.resolve('app-builder-lib/package.json'));
  const yaml = createRequire(path.join(root, 'package.json'))('js-yaml');
  const config = yaml.load(readFileSync(path.join(root, 'desktop/aionui/packages/desktop/electron-builder.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA });
  const producerVersion = requireApp('./package.json').version;
  assert.equal(producerVersion, '26.15.2', 'Review updater integration when changing the locked producer.');
  assert.equal(config.nsis.differentialPackage, false);
  assert.equal(config.publish.provider, 'github');
  assert.equal(config.publish.owner, 'bitboom');
  assert.equal(config.publish.repo, 'thor');
  assert.equal(config.publish.channel ?? 'latest', 'latest');
  const { createUpdateInfoTasks, writeUpdateInfoFiles } = requireApp('./out/publish/updateInfoBuilder.js');
  const { NsisTarget } = requireApp('./out/targets/nsis/NsisTarget.js');
  assert.equal(Object.getOwnPropertyDescriptor(NsisTarget.prototype, 'isBuildDifferentialAware').get.call({ isPortable: false, options: config.nsis }), false);
  const { Platform } = requireApp('./out/core.js');
  const { Arch } = requireApp('builder-util');
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'thor-updater-preflight-'));
  const version = readJson(path.join(root, 'package.json')).version;
  const name = `Thor-${version}-win-x64.exe`;
  const file = path.join(directory, name);
  const manifest = path.join(directory, 'latest.yml');
  const installer = Buffer.from('MZ synthetic updater integration fixture; never executed.');
  try {
    writeFileSync(file, installer, { flag: 'wx' });
    const packager = {
      appInfo: { version }, platform: Platform.WINDOWS, platformSpecificBuildOptions: {}, config: {},
      info: { metadata: requireDesktop('./package.json') }, getResource: async () => null, emitArtifactCreated: async () => {},
    };
    const tasks = await createUpdateInfoTasks({ file, target: { outDir: directory }, packager, arch: Arch.x64 }, [config.publish]);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].file, manifest);
    assert.equal(Object.hasOwn(tasks[0].info.files[0], 'size'), false);
    await writeUpdateInfoFiles(tasks, packager);
    assert.throws(() => validateUpdateManifest(readUpdateManifest(directory), { version, installer }), /Installer size mismatch/);
    assert.equal(completeUpdateManifestSize(directory, { version, installer }), name);
    assert.equal(readUpdateManifest(directory).files[0].size, installer.length);
    const before = readFileSync(manifest);
    completeUpdateManifestSize(directory, { version, installer });
    assert.deepEqual(readFileSync(manifest), before);
  } finally {
    if (path.dirname(realpathSync(directory)).toLowerCase() !== parent.toLowerCase()) throw new Error('Updater preflight cleanup escaped its owned temporary directory.');
    for (const owned of [manifest, file]) {
      try { unlinkSync(owned); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  }
  return { passed: true, producer: 'app-builder-lib', producerVersion, differentialPackage: false,
    synthetic: true, sizeCompleted: true, strictValidation: true, idempotent: true, cleanupCompleted: true,
    actualInstallerChecked: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  const { values } = parseArgs({ options: { preflight: { type: 'boolean' } }, strict: true });
  if (!values.preflight) throw new Error('Usage: node release/update-manifest.mjs --preflight');
  console.log(JSON.stringify(await updateManifestPreflight()));
}
