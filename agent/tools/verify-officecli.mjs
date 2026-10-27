#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { officecliPin } from './prepare-officecli.mjs';

const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const { values } = parseArgs({ options: { bundle: { type: 'string' }, workspace: { type: 'string' } }, strict: true });
try {
  assert.ok(values.bundle && path.isAbsolute(values.bundle) && values.workspace && path.isAbsolute(values.workspace), 'bundle and workspace must be absolute paths.');
  const asset = officecliPin.assets.find(item => item.runtimeKey === `${process.platform}-${process.arch}`);
  assert.ok(asset, 'No pinned OfficeCLI target.');
  const executable = path.join(values.bundle, 'managed-resources', 'officecli', officecliPin.version, asset.name);
  const bytes = await readFile(executable);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  const env = { ...process.env, OFFICECLI_SKIP_UPDATE: '1' };
  const version = (await execute(executable, ['--version'], { env, windowsHide: true })).stdout.trim();
  assert.equal(version, officecliPin.version.slice(1));
  await mkdir(values.workspace, { recursive: true });
  let watched = 0;
  for (const extension of ['docx', 'xlsx', 'pptx']) {
    const file = path.join(values.workspace, `synthetic-${extension}.${extension}`);
    await execute(executable, ['create', file, '--locale', 'en-US', '--json'], { env, windowsHide: true });
    assert.ok((await stat(file)).size > 0);
    if (extension === 'docx') await execute(executable, ['add', file, '/body', '--type', 'paragraph', '--prop', 'text=Thor synthetic Word preview acceptance.', '--json'], { env, windowsHide: true });
    if (extension === 'pptx') await execute(executable, ['add', file, '/', '--type', 'slide', '--prop', 'title=Thor synthetic PowerPoint preview', '--json'], { env, windowsHide: true });
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const processHandle = spawn(executable, ['watch', file, '--port', String(port)], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    let startError;
    processHandle.on('error', () => { startError = true; });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (startError || processHandle.exitCode !== null) throw new Error(`Pinned OfficeCLI ${extension} watch process exited.`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
          const html = await response.text();
          if (response.ok && /<html|<!doctype/i.test(html)) { ready = true; break; }
        } catch {}
        await pause(100);
      }
      assert.equal(ready, true, `Pinned OfficeCLI ${extension} preview did not return HTML.`);
      watched++;
    } finally {
      if (processHandle.exitCode === null) {
        const exited = new Promise(resolve => processHandle.once('exit', resolve));
        if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
        else processHandle.kill();
        await Promise.race([exited, pause(3000)]);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ passed: true, version, sha256: asset.sha256, syntheticFilesCreated: 3, liveWatchHtmlResponses: watched, formats: ['docx', 'xlsx', 'pptx'], visualFidelityTested: false })}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
