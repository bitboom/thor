import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, readJson, describeFile, digest } from './artifact-lib.mjs';

export function sourceProvenance() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const commit = git(['rev-parse', 'HEAD']).trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('Checked out source does not match workflow commit.');
  const inputs = ['.github', 'agent', 'contracts', 'desktop', 'host', 'integrations', 'release', 'tests', 'docs', 'AGENTS.md', 'README.md', 'LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'upstream.lock.json', 'justfile', '.gitignore', '.gitattributes'];
  // Git's canonical tree and filtered diff keep a clean checkout's identity
  // identical on Windows and Linux even when checkout line endings differ.
  const tree = git(['ls-tree', '-rz', '--full-tree', 'HEAD', '--', ...inputs]);
  const changes = git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...inputs]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...inputs]).split('\0').filter(Boolean).sort()
    .filter(file => existsSync(path.join(root, file))).map(file => ({ file, sha256: digest(readFileSync(path.join(root, file))) }));
  return { commit, dirty: git(['status', '--porcelain', '--untracked-files=normal', '--', ...inputs]).trim().length > 0, sha256: digest(JSON.stringify({ tree, changes, untracked })) };
}

export function stageResources(bundleProvenance, source) {
  const work = path.join(root, '.thor-local/release');
  const resources = path.join(root, 'desktop/aionui/resources/thor-release');
  const lock = readJson(path.join(root, 'upstream.lock.json'));
  mkdirSync(path.join(resources, 'tools'), { recursive: true });
  for (const [from, to] of [
    ['LICENSE', 'LICENSE.txt'], ['NOTICE', 'NOTICE.txt'],
    ['desktop/aionui/LICENSE', 'AionUi-LICENSE.txt'], ['host/aioncore/LICENSE', 'AionCore-LICENSE.txt'],
    ['upstream.lock.json', 'upstream.lock.json'],
  ]) copyFileSync(path.join(root, from), path.join(resources, to));
  for (const [from, to] of [['bin/gh.exe', 'gh.exe'], ['LICENSE', 'gh-LICENSE.txt']]) {
    copyFileSync(path.join(work, 'github-cli', from), path.join(resources, 'tools', to));
  }
  const githubCli = { ...describeFile(resources, 'tools/gh.exe'), version: lock.githubCli.version, archiveSha256: lock.githubCli.sha256 };
  if (githubCli.sha256 !== lock.githubCli.executableSha256) throw new Error('Staged GitHub CLI does not match pin.');
  writeFileSync(path.join(resources, 'thor-bundle.json'), JSON.stringify({ source, bundle: bundleProvenance, tools: { githubCli } }, null, 2) + '\n');

  const sections = ['Thor third-party notices\n\nPinned sources are recorded in upstream.lock.json and thor-build.json.\nThis inventory includes available dependency license/notice files from the build.\n'];
  const append = (label, directory, declaredLicense = '') => {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^(licen[cs]es?|copying|notice)(?:[._-]|$)/i.test(entry.name));
    sections.push(`\n=== ${label} ===\nDeclared license: ${declaredLicense || 'see source notices'}\n`);
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      sections.push(`\n--- ${entry.name} ---\n${readFileSync(path.join(directory, entry.name), 'utf8')}\n`);
    }
  };
  append('Thor', root, 'Apache-2.0');
  append('AionUi', path.join(root, 'desktop/aionui'), 'Apache-2.0');
  append('AionCore (upstream LICENSE; Cargo metadata declares MIT)', path.join(root, 'host/aioncore'), 'Apache-2.0; preserve upstream metadata discrepancy');
  append(`Node.js ${lock.managedNode.version}`, path.join(work, 'bundle/managed-resources/node', `node-v${lock.managedNode.version}-win-x64`));
  const office = readJson(path.join(root, lock.officeCliLock));
  append(`OfficeCLI ${office.version}`, path.join(work, 'bundle/managed-resources/officecli', office.version));
  append(`GitHub CLI ${lock.githubCli.version}`, path.join(work, 'github-cli'), 'MIT');
  append('Electron', path.join(root, 'desktop/aionui/node_modules/electron/dist'), 'MIT; Chromium third-party notices');

  const seen = new Set();
  const packages = [];
  const visitPackage = directory => {
    const resolved = realpathSync(directory);
    if (seen.has(resolved) || !existsSync(path.join(resolved, 'package.json'))) return;
    seen.add(resolved);
    const pkg = readJson(path.join(resolved, 'package.json'));
    packages.push({ directory: resolved, name: pkg.name || 'unnamed', version: pkg.version || 'unknown', license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || pkg.licenses || '') });
    visitModules(path.join(resolved, 'node_modules'));
  };
  const visitModules = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(target)) visitPackage(path.join(target, scoped));
      } else visitPackage(target);
    }
  };
  visitModules(path.join(root, 'desktop/aionui/node_modules'));
  for (const pkg of packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))) append(`npm ${pkg.name}@${pkg.version}`, pkg.directory, pkg.license);
  const cargo = readJson(path.join(work, 'cargo-metadata.json'));
  for (const pkg of cargo.packages.toSorted((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))) {
    append(`Cargo ${pkg.name}@${pkg.version}`, path.dirname(pkg.manifest_path), pkg.license);
    if (pkg.license_file) {
      const licenseFile = path.resolve(path.dirname(pkg.manifest_path), pkg.license_file);
      sections.push(`\n--- Declared license file ---\n${readFileSync(licenseFile, 'utf8')}\n`);
    }
  }
  writeFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.txt'), sections.join(''));
  return { resources, tools: { githubCli } };
}
