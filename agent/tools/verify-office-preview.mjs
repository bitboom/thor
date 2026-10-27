#!/usr/bin/env node
// Live acceptance only: real Core routes + pinned OfficeCLI, synthetic files.
// Protocol sources: aionui-api-types/src/office.rs and aionui-office/src/routes.rs.
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, stat, realpath } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createServer, createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createPreviewProcessOwner, plannedFixturePaths, closeFixtureResidents, runPreviewAcceptance } from './owned-preview-process.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const formats = [{ format: 'docx', route: 'word' }, { format: 'xlsx', route: 'excel' }, { format: 'pptx', route: 'ppt' }];
const usage = 'Usage: node agent/tools/verify-office-preview.mjs --bundle ABS_CORE_BUNDLE --lock ABS_EFFECTIVE_LOCK --state-root ABS_SYNTHETIC_STATE [--core ABS_CORE_EXE] [--readonly-reject-core ABS_BASELINE_LOCK_CORE] [--evidence ABS_JSON]\n';

function childEnvironment(extra = {}) {
  const env = { ...process.env };
  delete env.THOR_CORE_LOCAL_TOKEN;
  delete env.THOR_CORE_TRUSTED_ORIGIN;
  return { ...env, ...extra };
}

async function cli(executable, args, label) {
  try {
    return await execute(executable, [...args, '--json'], {
      windowsHide: true, env: childEnvironment({ OFFICECLI_SKIP_UPDATE: '1' }), timeout: 45000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch { throw new Error(`OfficeCLI failed during ${label}.`); }
}

// Verified against v1.0.159 help/readme. Each file is closed before disk reads
// or copies; the CLI otherwise retains a resident editing session.
export async function createSyntheticFixtures(executable, workspace) {
  await mkdir(workspace, { recursive: true });
  const nonce = randomUUID().replaceAll('-', '');
  const documents = [];
  for (const entry of formats) {
    const original = path.join(workspace, `synthetic-original.${entry.format}`);
    const working = path.join(workspace, `synthetic-copy.${entry.format}`);
    const baseline = `THOR_BASE_${entry.format}_${nonce}`;
    const changed = `THOR_EDIT_${entry.format}_${nonce}`;
    await cli(executable, ['create', original, '--locale', 'en-US'], 'synthetic creation');
    if (entry.format === 'docx') await cli(executable, ['add', original, '/body', '--type', 'paragraph', '--prop', `text=${baseline}`], 'Word fixture');
    if (entry.format === 'xlsx') await cli(executable, ['set', original, '/Sheet1/A1', '--prop', `value=${baseline}`], 'Excel fixture');
    if (entry.format === 'pptx') {
      await cli(executable, ['add', original, '/', '--type', 'slide', '--prop', 'title=Thor synthetic preview'], 'PowerPoint slide');
      await cli(executable, ['add', original, '/slide[1]', '--type', 'shape', '--prop', `text=${baseline}`, '--prop', 'x=2cm', '--prop', 'y=4cm', '--prop', 'size=20'], 'PowerPoint fixture');
    }
    await cli(executable, ['close', original], 'fixture close');
    await cli(executable, ['validate', original], 'fixture validation');
    await cli(executable, ['close', original], 'validated fixture close');
    assert.ok((await stat(original)).size > 0, 'Synthetic document is empty.');
    const hash = digest(await readFile(original));
    await copyFile(original, working); // independent files, never hardlinks
    assert.equal(digest(await readFile(working)), hash);
    documents.push({ ...entry, original, working, baseline, changed, hash });
  }
  return documents;
}

async function editCopy(executable, document) {
  const file = document.working;
  if (document.format === 'docx') await cli(executable, ['add', file, '/body', '--type', 'paragraph', '--prop', `text=${document.changed}`], 'authorized Word edit');
  if (document.format === 'xlsx') await cli(executable, ['set', file, '/Sheet1/A2', '--prop', `value=${document.changed}`], 'authorized Excel edit');
  if (document.format === 'pptx') await cli(executable, ['add', file, '/slide[1]', '--type', 'shape', '--prop', `text=${document.changed}`, '--prop', 'x=2cm', '--prop', 'y=7cm', '--prop', 'size=20'], 'authorized PowerPoint edit');
  await cli(executable, ['close', file], 'edited copy close');
  const changedHash = digest(await readFile(file));
  assert.notEqual(changedHash, document.hash, 'Authorized CLI edit was not saved.');
  const readback = await cli(executable, ['get', file, document.format === 'docx' ? '/body' : '/', '--depth', '8'], 'independent saved-document readback');
  assert.ok(readback.stdout.includes(document.changed), 'Saved document does not contain the edit marker.');
  await cli(executable, ['close', file], 'readback close');
  return changedHash;
}

function http(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) req.destroy(new Error('Preview response exceeds the synthetic test bound.'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('Preview request timeout.')));
    req.on('error', reject);
    req.end(body);
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function requireClosed(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!await listening(port)) { await pause(150); if (!await listening(port)) return; }
    await pause(100);
  }
  throw new Error('An owned preview port remained open after stop/close.');
}

async function startCore(binary, managed, state, workspace) {
  await mkdir(state, { recursive: true });
  const port = await reservePort();
  const token = randomBytes(32).toString('hex');
  // Windows Core observes this dedicated sentinel's exit through its documented
  // --parent-pid monitor. This lets acceptance exercise graceful desktop close
  // without terminating the harness or sending an unsupported Windows signal.
  const owner = createPreviewProcessOwner({ requireClosed, terminate: async child => {
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    else assert.equal(child.kill('SIGKILL'), true, 'Owned preview process could not be signaled.');
  } });
  let sentinel;
  try {
    if (process.platform === 'win32') {
      sentinel = owner.adopt('parent', spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: childEnvironment(),
      }));
      await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
    }
    owner.adopt('Core', spawn(binary, ['--local', '--host', '127.0.0.1', '--port', String(port), '--parent-pid', String(sentinel?.pid ?? process.pid),
      '--data-dir', path.join(state, 'data'), '--work-dir', workspace, '--managed-resources-mode', 'bundled', '--log-level', 'error'], {
      windowsHide: true, stdio: 'ignore', env: childEnvironment({ THOR_CORE_LOCAL_TOKEN: token,
        AIONUI_BUNDLED_MANAGED_RESOURCES: managed, CODEX_SQLITE_HOME: path.join(state, 'codex-sqlite'),
        OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_WATCH_ALLOWED_HOSTS: 'thor-untrusted.invalid' }),
    }));
    owner.trackPort(port);
    const headers = { 'X-Thor-Local-Token': token };
    const channel = {
      port,
      trackPreviewPort: port => owner.trackPort(port),
      async get(route, extraHeaders = {}) { owner.assertLive(); return http(port, route, { headers: { ...headers, ...extraHeaders } }); },
      async post(route, payload) {
        owner.assertLive();
        const response = await http(port, route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        assert.equal(response.status, 200, 'Core Office route returned an unexpected HTTP status.');
        let result;
        try { result = JSON.parse(response.text); } catch { throw new Error('Core Office route did not return JSON.'); }
        assert.equal(result.success, true, 'Core Office route returned a failed envelope.');
        return result.data;
      },
      async close() {
        await owner.close({
          requestParentExit: parent => new Promise((resolve, reject) => {
            parent.stdin.once('error', reject); parent.stdin.end(resolve);
          }),
          requestCoreExit: core => { assert.equal(core.kill('SIGTERM'), true, 'Core graceful close could not be requested.'); },
        });
      },
      cleanup: () => owner.cleanup(),
    };
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      owner.assertLive();
      try { if ((await channel.get('/health')).status === 200) return channel; } catch {}
      await pause(100);
    }
    throw new Error('Core did not become ready for Office acceptance.');
  } catch (error) {
    try { await owner.cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Core startup failed and preview cleanup is unproven.'); }
    throw error;
  }
}

function previewPort(url, document) {
  const match = /^\/api\/(office-watch-proxy|ppt-proxy)\/(\d+)$/.exec(url);
  assert.ok(match, 'Core returned an unexpected preview URL.');
  assert.equal(match[1], document.format === 'pptx' ? 'ppt-proxy' : 'office-watch-proxy');
  const port = Number(match[2]);
  assert.ok(port >= 1 && port <= 65535);
  return port;
}

async function requireHtml(port, marker) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await http(port, '/');
      if (response.status === 200 && /<html|<!doctype/i.test(response.text) && response.text.includes(marker)) return;
    } catch {}
    await pause(100);
  }
  throw new Error('Preview HTML did not contain the expected synthetic content.');
}

async function readOnlyChecks(port, document) {
  const origin = `http://127.0.0.1:${port}`;
  const probes = [
    ...['/api/switch', '/api/send', '/api/batch'].flatMap(route => [undefined, origin].map(Origin => ({ route, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(Origin ? { Origin } : {}) }, body: JSON.stringify({ file: document.working, command: 'set', path: '/body/p[1]', props: { text: 'THOR_HTTP_MUST_NOT_WRITE' } }) }))),
    { route: '/api/status' },
    ...['null', 'https://thor-untrusted.invalid', 'http://127.0.0.1:1'].map(Origin => ({ route: '/', headers: { Origin } })),
    { route: '/', headers: { Host: `thor-untrusted.invalid:${port}` } },
    { route: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } },
  ];
  for (const { route, ...options } of probes) assert.equal((await http(port, route, options)).status, 403, 'Watch listener accepted a forbidden request.');
  assert.equal((await http(port, '/', { headers: { Origin: origin } })).status, 200);
  assert.equal(digest(await readFile(document.working)), document.hash, 'HTTP requests changed the working document.');
  return probes.length;
}

async function faultBundle(managed, manifest, output, asset, mode) {
  await mkdir(output, { recursive: true });
  const nodeRoot = manifest.node?.root;
  assert.ok(typeof nodeRoot === 'string' && nodeRoot.length > 0 && !path.isAbsolute(nodeRoot) && !nodeRoot.split(/[\\/]/).includes('..'), 'Unsafe managed Node manifest.');
  await cp(path.join(managed, nodeRoot), path.join(output, nodeRoot), { recursive: true, dereference: true, errorOnExist: true, force: false });
  await copyFile(path.join(managed, 'manifest.json'), path.join(output, 'manifest.json'));
  if (mode === 'tampered') {
    const target = path.join(output, 'officecli', asset.version, asset.name);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = await readFile(path.join(managed, 'officecli', asset.version, asset.name));
    bytes[bytes.length - 1] ^= 1; // same-size corruption only in our fresh copy
    await writeFile(target, bytes, { flag: 'wx' });
  }
}

export async function verifyOfficePreview(options) {
  for (const key of ['bundle', 'lock', 'state-root']) assert.ok(options[key] && path.isAbsolute(options[key]), `${key} must be absolute.`);
  for (const key of ['core', 'readonly-reject-core', 'evidence']) if (options[key]) assert.ok(path.isAbsolute(options[key]), `${key} must be absolute.`);
  const bundle = await realpath(options.bundle);
  const managed = path.join(bundle, 'managed-resources');
  const binary = options.core ?? path.join(bundle, process.platform === 'win32' ? 'aioncore.exe' : 'aioncore');
  const lock = JSON.parse(await readFile(options.lock, 'utf8'));
  assert.ok(lock.schemaVersion === 1 && /^v\d+\.\d+\.\d+$/.test(lock.version), 'Unsupported OfficeCLI lock.');
  const asset = lock.assets?.find(entry => entry.runtimeKey === `${process.platform}-${process.arch}`);
  assert.ok(asset?.readOnlyWatch && /^officecli[-a-z0-9.]+$/i.test(asset.name), 'A verified read-only target is required.');
  const executable = path.join(managed, 'officecli', lock.version, asset.name);
  const officeBytes = await readFile(executable);
  assert.equal(officeBytes.length, asset.size);
  assert.equal(digest(officeBytes), asset.sha256);
  const coreSha256 = digest(await readFile(binary));
  const manifest = JSON.parse(await readFile(path.join(managed, 'manifest.json'), 'utf8'));
  await mkdir(options['state-root'], { recursive: true });
  const run = await mkdtemp(path.join(await realpath(options['state-root']), 'office-preview-'));
  const workspace = path.join(run, 'workspace');
  // Register every possible resident path before the first create/add/validate
  // command: a partial fixture failure must still close original and copy paths.
  const cleanupPaths = plannedFixturePaths(workspace, formats);
  let documents;
  const result = { schemaVersion: 1, synthetic: true, passed: false, coreSha256, officecliSha256: asset.sha256,
    coreApi: true, formats: [], errorCodes: {}, installedDesktop: false, visualFidelityTested: false };
  let core;
  const open = new Map();
  return runPreviewAcceptance({ result, verify: async () => {
    documents = await createSyntheticFixtures(executable, workspace);
    core = await startCore(binary, managed, path.join(run, 'positive'), workspace);
    for (const document of documents) {
      const payload = { file_path: document.working, workspace };
      const started = await core.post(`/api/${document.route}-preview/start`, payload);
      assert.ok(!started.error, `Core preview start failed: ${started.error || 'unknown'}.`);
      const port = previewPort(started.url, document);
      core.trackPreviewPort(port);
      open.set(document.format, { document, port });
      await requireHtml(port, document.baseline);
      const proxied = await core.get(started.url, { Origin: 'null', Referer: 'file:///synthetic-private-renderer/index.html' });
      assert.equal(proxied.status, 200);
      assert.ok(/<html|<!doctype/i.test(proxied.text) && proxied.text.includes(document.baseline));
      const deniedHttpRequests = await readOnlyChecks(port, document);
      const changedHash = await editCopy(executable, document);
      const refreshed = await core.post(`/api/${document.route}-preview/refresh`, payload);
      assert.equal(refreshed.ok, true, `Core refresh failed: ${refreshed.error || 'unknown'}.`);
      const repeated = await core.post(`/api/${document.route}-preview/start`, payload);
      assert.equal(previewPort(repeated.url, document), port, 'Refresh changed the preview port.');
      await requireHtml(port, document.changed);
      assert.equal(digest(await readFile(document.original)), document.hash, 'The original document changed.');
      assert.equal(digest(await readFile(document.working)), changedHash, 'Refresh changed the saved copy.');
      await core.post(`/api/${document.route}-preview/stop`, { file_path: document.working });
      await requireClosed(port);
      open.delete(document.format);
      assert.equal((await core.get(started.url)).status, 403, 'Stopped proxy remained available.');
      const afterStop = await core.post(`/api/${document.route}-preview/refresh`, payload);
      assert.deepEqual(afterStop, { ok: false, error: 'OFFICECLI_NO_ACTIVE_PREVIEW' });
      result.formats.push({ format: document.format, initialHtml: true, proxyHtml: true, deniedHttpRequests,
        authorizedCliEdit: true, independentSavedReadback: true, refreshHtml: true, refreshSamePort: true,
        originalSha256: document.hash, copyInitialSha256: document.hash, copyEditedSha256: changedHash, stopReleasedPort: true });
    }
    // Re-open all three, then exercise graceful desktop-parent exit with live
    // watchers. A forced process-tree cleanup never counts as a successful close.
    for (const document of documents) {
      const started = await core.post(`/api/${document.route}-preview/start`, { file_path: document.working, workspace });
      assert.ok(!started.error);
      const port = previewPort(started.url, document);
      core.trackPreviewPort(port);
      open.set(document.format, { document, port });
      await requireHtml(port, document.changed);
    }
    await core.close();
    for (const { port } of open.values()) await requireClosed(port);
    open.clear();
    result.gracefulCoreCloseReleasedPreviewPorts = true;
    await core.cleanup();
    core = undefined;
    for (const [mode, code] of [['missing', 'OFFICECLI_BUNDLE_MISSING'], ['tampered', 'OFFICECLI_INTEGRITY_FAILED']]) {
      const variant = path.join(run, `bundle-${mode}`, 'managed-resources');
      await faultBundle(managed, manifest, variant, { ...asset, version: lock.version }, mode);
      core = await startCore(binary, variant, path.join(run, `fault-${mode}`), workspace);
      const denied = await core.post('/api/word-preview/start', { file_path: documents[0].working, workspace });
      assert.equal(denied.url, '');
      assert.equal(denied.error, code, 'Core returned the wrong bundle policy error.');
      result.errorCodes[mode] = { executed: true, code };
      await core.close(); await core.cleanup(); core = undefined;
    }
    if (options['readonly-reject-core']) {
      core = await startCore(options['readonly-reject-core'], managed, path.join(run, 'fault-readonly'), workspace);
      const denied = await core.post('/api/word-preview/start', { file_path: documents[0].working, workspace });
      assert.equal(denied.url, '');
      assert.equal(denied.error, 'OFFICECLI_READONLY_REQUIRED');
      result.errorCodes.readOnly = { executed: true, code: denied.error, coreSha256: digest(await readFile(options['readonly-reject-core'])) };
      await core.close(); await core.cleanup(); core = undefined;
    } else result.errorCodes.readOnly = { executed: false, reason: 'Requires a separate patched Core compiled with the baseline non-readonly lock; a runtime JSON edit cannot change the embedded policy.' };
    for (const document of documents) assert.equal(digest(await readFile(document.original)), document.hash);
    assert.equal(digest(await readFile(executable)), asset.sha256, 'The verified input OfficeCLI changed.');
    assert.equal(digest(await readFile(binary)), coreSha256, 'The verified input Core changed.');
    result.verifiedInputBinariesUnchanged = true;
  }, cleanup: [async () => {
    const failures = [];
    if (core) {
      for (const { document } of open.values()) {
        try { await core.post(`/api/${document.route}-preview/stop`, { file_path: document.working }); }
        catch (error) { failures.push(error); }
      }
      try { await core.cleanup(); } catch (error) { failures.push(error); }
    }
    for (const { port } of open.values()) {
      try { await requireClosed(port); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Final Core/preview cleanup failed.');
    core = undefined; open.clear();
  }, () => closeFixtureResidents(cleanupPaths, file => cli(executable, ['close', file], 'cleanup close'))], writeEvidence: options.evidence
    ? final => writeFile(options.evidence, `${JSON.stringify(final, null, 2)}\n`, { flag: 'wx' }) : undefined });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { bundle: { type: 'string' }, lock: { type: 'string' }, 'state-root': { type: 'string' }, core: { type: 'string' }, 'readonly-reject-core': { type: 'string' }, evidence: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) process.stdout.write(usage);
  else {
    try { process.stdout.write(`${JSON.stringify(await verifyOfficePreview(values))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
