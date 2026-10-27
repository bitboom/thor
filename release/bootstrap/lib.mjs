import { createHash } from 'node:crypto';

export const generatedPaths = new Set(['release/bootstrap/manifest.json', 'release/bootstrap/integration.patch']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function treeEntries(listing) {
  return listing.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = record.match(/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/s);
    if (!match || match[2] !== 'blob') throw new Error('Bootstrap source must contain files, without Git submodules.');
    return { mode: match[1], object: match[3], path: match[4] };
  });
}

export function snapshotDigest(entries) {
  const source = entries.filter(entry => !generatedPaths.has(entry.path))
    .toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return sha256(JSON.stringify(source));
}

export function verifyPatch(bytes, expected) {
  if (sha256(bytes) !== expected) throw new Error('Bootstrap patch checksum mismatch.');
  const headers = bytes.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('diff --git '));
  if (!headers.length || headers.some(line => !/^diff --git "?a\/(?:desktop\/aionui|host\/aioncore)\/.+ "?b\/(?:desktop\/aionui|host\/aioncore)\/.+$/.test(line))) {
    throw new Error('Bootstrap patch may change only the two pinned source subtrees.');
  }
}

export function validateManifest(manifest, upstream) {
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceTreeSha256) || !Number.isSafeInteger(manifest.sourceTreeFileCount) || manifest.sourceTreeFileCount < 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid bootstrap source manifest.');
  if (manifest.patch?.file !== 'release/bootstrap/integration.patch' || !/^[a-f0-9]{64}$/.test(manifest.patch.sha256)) throw new Error('Invalid bootstrap patch manifest.');
  for (const [name, repository, directory] of [
    ['desktop', 'https://github.com/iOfficeAI/AionUi', 'desktop/aionui'],
    ['host', 'https://github.com/iOfficeAI/AionCore', 'host/aioncore'],
  ]) {
    const source = manifest.upstream?.[name];
    if (source?.repository !== repository || source.directory !== directory || !/^[a-f0-9]{40}$/.test(source.commit) || source.commit !== upstream[name].commit || source.repository !== upstream[name].repository || source.directory !== upstream[name].directory) throw new Error('Bootstrap source does not match the pinned upstream lock.');
  }
  return manifest;
}
