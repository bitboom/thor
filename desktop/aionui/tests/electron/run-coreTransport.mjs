import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = path.resolve(import.meta.dirname, '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'thor-electron-policy-build-'));
const bundle = path.join(dir, 'coreTransport.cjs');
const cdpBundle = path.join(dir, 'cdpBridge.cjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
function run(executable, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Synthetic Electron check timed out.'));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Synthetic check exited ${code}`));
    });
  });
}
try {
  await run(process.env.THOR_BUN_EXE || 'bun', [
    'build',
    'packages/desktop/src/process/startup/coreTransport.ts',
    '--target=node',
    '--format=cjs',
    '--outfile',
    bundle,
  ]);
  await run(electron, ['tests/electron/coreTransport.integration.cjs', bundle]);
  await run(process.env.THOR_BUN_EXE || 'bun', [
    'build',
    'packages/desktop/src/process/resources/builtinMcp/cdpBridge.ts',
    '--target=node',
    '--format=cjs',
    '--external',
    'electron',
    '--outfile',
    cdpBundle,
  ]);
  await run(electron, ['tests/electron/cdpBridge.integration.cjs', cdpBundle]);
} finally {
  await rm(bundle, { force: true });
  await rm(cdpBundle, { force: true });
  await rmdir(dir);
}
