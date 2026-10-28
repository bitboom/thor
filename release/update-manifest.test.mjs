import test from 'node:test';
import assert from 'node:assert/strict';
import { updateManifestPreflight } from './update-manifest.mjs';

test('locked electron-builder producer YAML completes size and passes the unchanged strict verifier', async () => {
  assert.deepEqual(await updateManifestPreflight(), {
    passed: true, producer: 'app-builder-lib', producerVersion: '26.15.2', differentialPackage: false,
    synthetic: true, sizeCompleted: true, strictValidation: true, idempotent: true, cleanupCompleted: true,
    actualInstallerChecked: false,
  });
});
