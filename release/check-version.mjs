import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root, readJson } from './artifact-lib.mjs';

const pkg = readJson(path.join(root, 'package.json'));
const npmLock = readJson(path.join(root, 'package-lock.json'));
const desktop = readJson(path.join(root, 'desktop/aionui/package.json'));
const upstream = readJson(path.join(root, 'upstream.lock.json'));
if (!/^\d+\.\d+\.\d+$/.test(desktop.version) || pkg.version !== desktop.version || npmLock.version !== desktop.version || npmLock.packages[''].version !== desktop.version) throw new Error('Workspace, lockfile and desktop versions must match.');
if (desktop.aioncoreVersion !== upstream.host.tag) throw new Error('Desktop Core version does not match source lock.');
const cargo = readFileSync(path.join(root, 'host/aioncore/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/\[workspace\.package\]\s+version\s*=\s*"([^"]+)"/s)?.[1];
if (`v${cargoVersion}` !== upstream.host.tag) throw new Error('Core source version does not match source lock.');
const toolchain = readFileSync(path.join(root, 'host/aioncore/rust-toolchain.toml'), 'utf8');
if (!toolchain.includes(`channel = "${upstream.toolchain.rust}"`)) throw new Error('Rust toolchain does not match source lock.');
const officeSource = readJson(path.join(root, upstream.officeCliSourceLock));
if (officeSource.sdkVersion !== upstream.toolchain.dotnet) throw new Error('OfficeCLI SDK version does not match source lock.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${desktop.version}`) throw new Error('Release tag does not match package version.');
console.log(`Verified Thor ${desktop.version} and pinned Core/toolchain versions.`);
