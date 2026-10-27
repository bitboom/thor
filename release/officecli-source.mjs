import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function derivativeLock(baseline, pin, binary) {
  const lock = structuredClone(baseline);
  const asset = lock.assets.find(item => item.runtimeKey === 'win32-x64');
  if (!asset || baseline.version !== pin.version || pin.policy !== 'thor-readonly-v1') throw new Error('Invalid OfficeCLI source pin.');
  Object.assign(asset, {
    size: binary.length, sha256: hash(binary), readOnlyWatch: true,
    source: { repository: pin.repository, commit: pin.commit, patchSha256: pin.patch.sha256, policy: pin.policy, sdkVersion: pin.sdkVersion },
  });
  return lock;
}

export function buildOfficecli({ output, source, dotnet = 'dotnet' }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('OfficeCLI release build requires Windows x64.');
  if (!path.isAbsolute(output) || (source && !path.isAbsolute(source))) throw new Error('Build paths must be absolute.');
  const pin = JSON.parse(readFileSync(path.join(root, 'release/officecli-source.lock.json'), 'utf8'));
  const patchPath = path.join(root, pin.patch.file);
  if (hash(readFileSync(patchPath)) !== pin.patch.sha256) throw new Error('OfficeCLI patch checksum mismatch.');
  const run = (exe, args, options = {}) => execFileSync(exe, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  if (run(dotnet, ['--version'], { env, encoding: 'utf8' }).trim() !== pin.sdkVersion) throw new Error('OfficeCLI SDK does not match the source pin.');
  mkdirSync(output, { recursive: true });
  source ||= path.join(output, 'source');
  if (!existsSync(source)) run('git', ['clone', '--depth', '1', '--branch', pin.version, pin.repository, source], { stdio: 'inherit' });
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']).toString().trim() !== pin.commit) throw new Error('OfficeCLI checkout differs from its pinned commit.');
  // Treat a supplied/cache checkout only as an object store. Never compile its
  // index, untracked files, or cached MSBuild inputs. Every build checks out the
  // exact upstream commit into a fresh private directory before applying Thor.
  const buildSource = path.join(output, `checkout-${randomUUID()}`);
  run('git', ['clone', '--no-checkout', '--shared', source, buildSource]);
  source = buildSource;
  const git = args => run('git', ['-C', source, ...args]);
  git(['checkout', '--detach', pin.commit]);
  git(['apply', '--check', patchPath]);
  git(['apply', patchPath]);
  if (hash(git(['diff', 'HEAD', '--binary', '--full-index'])) !== pin.patch.sha256) throw new Error('OfficeCLI source contains an unreviewed modification.');
  const project = path.join(source, 'src/officecli/officecli.csproj');
  const packageLock = path.join(root, 'release/officecli.packages.lock.json');
  if (hash(readFileSync(packageLock)) !== pin.packageLockSha256) throw new Error('OfficeCLI dependency lock checksum mismatch.');
  const projectLock = path.join(source, 'src/officecli/packages.lock.json');
  copyFileSync(packageLock, projectLock);
  const publish = path.join(output, `publish-${randomUUID()}`);
  console.log('Building pinned OfficeCLI with the Thor read-only listener patch.');
  const isolation = ['-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:ImportDirectoryPackagesProps=false'];
  run(dotnet, ['restore', project, '-r', 'win-x64', '--locked-mode', '-p:PublishTrimmed=false', ...isolation], { env, stdio: 'inherit' });
  run(dotnet, ['publish', project, '--no-restore', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', publish,
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:PublishTrimmed=false', '-p:DebugType=None', '-p:DebugSymbols=false',
    '-p:ContinuousIntegrationBuild=true', `-p:PathMap=${source}=officecli`, ...isolation], { env, stdio: 'inherit' });
  const binary = readFileSync(path.join(publish, 'officecli.exe'));
  const baseline = JSON.parse(readFileSync(path.join(root, 'host/aioncore/crates/aionui-office/assets/officecli.lock.json'), 'utf8'));
  const effective = derivativeLock(baseline, pin, binary);
  const asset = effective.assets.find(item => item.runtimeKey === 'win32-x64');
  const destination = path.join(output, 'managed-resources/officecli', effective.version);
  mkdirSync(destination, { recursive: true });
  // Preserve the canonical upstream bytes, independent of Windows checkout EOL.
  for (const name of ['LICENSE', 'NOTICE']) writeFileSync(path.join(destination, name), git(['show', `${pin.commit}:${name}`]));
  if (hash(readFileSync(path.join(destination, 'LICENSE'))) !== baseline.licenseSha256) throw new Error('OfficeCLI license checksum mismatch.');
  copyFileSync(path.join(publish, 'officecli.exe'), path.join(destination, asset.name));
  if (statSync(path.join(destination, asset.name)).size !== asset.size) throw new Error('OfficeCLI binary copy size mismatch.');
  const effectiveLockPath = path.join(output, 'effective-lock.json');
  writeFileSync(effectiveLockPath, `${JSON.stringify(effective, null, 2)}\n`);
  console.log(`Built read-only OfficeCLI ${effective.version}: ${asset.sha256}`);
  return { effectiveLockPath, binaryPath: path.join(destination, asset.name), source: asset.source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, source: { type: 'string' }, dotnet: { type: 'string' } }, strict: true });
  if (!values.output) throw new Error('Usage: node release/officecli-source.mjs --output ABS_PATH [--source ABS_PATH] [--dotnet EXE]');
  buildOfficecli(values);
}
