import path from 'node:path';
import { root, readJson, verifyRelease } from './artifact-lib.mjs';
import { sourceProvenance } from './stage-resources.mjs';

const pkg = readJson(path.join(root, 'desktop/aionui/package.json'));
const output = path.resolve(process.argv[2] || path.join(root, 'desktop/aionui/out'));
const result = verifyRelease({
  output,
  version: pkg.version,
  upstream: readJson(path.join(root, 'upstream.lock.json')),
  tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null,
  commit: process.env.GITHUB_SHA || null,
  sourceSha256: sourceProvenance().sha256,
});
console.log(`Verified ${result.installer}: updater SHA512, release SHA256, version, source and bundled tool pins.`);
