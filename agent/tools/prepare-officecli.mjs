#!/usr/bin/env node
// Build-time only. The application has no runtime OfficeCLI download path.
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, chmod, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const officecliPin = JSON.parse(await readFile(new URL('../../host/aioncore/crates/aionui-office/assets/officecli.lock.json', import.meta.url), 'utf8'));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function verified(filePath, sha256, size) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || (size !== undefined && metadata.size !== size)) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex') === sha256;
  } catch { return false; }
}

export async function downloadVerifiedFile({ url, filePath, sha256, size, maxBytes = size, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid pinned asset metadata.');
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.download.lock`;
  let lock;
  const deadline = Date.now() + 15000;
  while (!lock) {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw new Error('Pinned download is locked; retry the build after checking the other downloader.');
      await pause(100);
    }
  }
  const temporary = `${filePath}.part-${randomUUID()}`;
  let destination;
  try {
    if (await verified(filePath, sha256, size)) return { reused: true, sha256 };
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error('Pinned asset download failed.');
    const declaredSize = response.headers.get('content-length');
    if (declaredSize && (Number(declaredSize) > maxBytes || (size !== undefined && Number(declaredSize) !== size))) throw new Error('Pinned asset download size mismatch.');
    destination = await open(temporary, 'wx');
    const hash = createHash('sha256');
    let count = 0;
    for await (const chunk of response.body) {
      count += chunk.byteLength;
      if (count > maxBytes) throw new Error('Pinned asset exceeded its allowed size.');
      hash.update(chunk);
      await destination.writeFile(chunk);
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    if ((size !== undefined && count !== size) || hash.digest('hex') !== sha256) throw new Error('Pinned asset checksum or size mismatch.');
    // A corrupted prior build artifact can be replaced only after the new bytes
    // are fully verified. All cooperating build processes hold this file lock.
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
    return { reused: false, sha256 };
  } finally {
    await destination?.close().catch(() => {});
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function prepareOfficecli({ bundleRoot, runtimeKey = `${process.platform}-${process.arch}`, fetchImpl = fetch }) {
  if (!path.isAbsolute(bundleRoot)) throw new Error('bundleRoot must be absolute.');
  const asset = officecliPin.assets.find(item => item.runtimeKey === runtimeKey);
  if (!asset || officecliPin.schemaVersion !== 1 || !/^v\d+\.\d+\.\d+$/.test(officecliPin.version) || !/^[\w.-]+$/.test(asset.name)) throw new Error('Unsupported OfficeCLI bundle target.');
  const root = path.join(bundleRoot, 'managed-resources', 'officecli', officecliPin.version);
  const executable = path.join(root, asset.name);
  const binary = await downloadVerifiedFile({ url: `${officecliPin.downloadBase}/${asset.name}`, filePath: executable, sha256: asset.sha256, size: asset.size, fetchImpl });
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  await downloadVerifiedFile({ url: officecliPin.licenseUrl, filePath: path.join(root, 'LICENSE'), sha256: officecliPin.licenseSha256, maxBytes: 65536, fetchImpl });
  return { version: officecliPin.version, runtimeKey, asset: asset.name, size: asset.size, sha256: binary.sha256, reused: binary.reused };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { bundle: { type: 'string' }, target: { type: 'string' } }, strict: true });
    if (!values.bundle) throw new Error('Usage: node agent/tools/prepare-officecli.mjs --bundle /absolute/core-bundle [--target win32-x64]');
    process.stdout.write(`${JSON.stringify(await prepareOfficecli({ bundleRoot: values.bundle, runtimeKey: values.target }))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
