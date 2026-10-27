import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { values } = parseArgs({ options: { bundle: { type: 'string' }, lock: { type: 'string' }, workspace: { type: 'string' } }, strict: true });
assert.ok(values.bundle && values.lock && values.workspace && Object.values(values).every(value => path.isAbsolute(value)));
const lock = JSON.parse(await readFile(values.lock, 'utf8'));
const asset = lock.assets.find(item => item.runtimeKey === 'win32-x64');
assert.equal(asset.readOnlyWatch, true);
const executable = path.join(values.bundle, 'managed-resources/officecli', lock.version, asset.name);
const binary = await readFile(executable);
assert.equal(binary.length, asset.size);
assert.equal(hash(binary), asset.sha256);
await mkdir(values.workspace, { recursive: true });
const file = path.join(values.workspace, 'synthetic-readonly.docx');
const env = { ...process.env, OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_WATCH_ALLOWED_HOSTS: 'untrusted.invalid' };
await execute(executable, ['create', file, '--json'], { windowsHide: true, env });
await execute(executable, ['add', file, '/body', '--type', 'paragraph', '--prop', 'text=Thor read-only listener fixture', '--json'], { windowsHide: true, env });
await execute(executable, ['close', file, '--json'], { windowsHide: true, env });
const originalHash = hash(await readFile(file));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const child = spawn(executable, ['watch', file, '--port', String(port)], { windowsHide: true, stdio: 'ignore', env });
let spawnError;
child.on('error', error => { spawnError = error; });
const http = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; if (text.length > 8 * 1024 * 1024) req.destroy(new Error('Unexpectedly large preview response')); });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.setTimeout(15000, () => req.destroy(new Error('Preview HTTP timeout')));
  req.on('error', reject);
  req.end(body);
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error('Read-only watch failed to start');
    try { const response = await http('/'); if (response.status === 200 && /<html|<!doctype/i.test(response.text)) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert.equal(ready, true, 'Read-only preview must return rendered HTML');
  const sameOrigin = `http://127.0.0.1:${port}`;
  assert.equal((await http('/', { headers: { Origin: sameOrigin } })).status, 200);
  const probes = [
    ...['/api/send', '/api/batch', '/api/switch', '/api/selection'].flatMap(route => [undefined, 'null', 'https://untrusted.invalid', 'http://127.0.0.1:1', sameOrigin].map(origin => ({ route, method: 'POST', headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ file, command: 'set', path: '/body/p[1]', props: { text: 'MUST NOT WRITE' } }) }))),
    ...['/api/status', '/?x=1', '/events?x=1', '//', '/anything'].map(route => ({ route })),
    ...['null', 'https://untrusted.invalid', 'http://127.0.0.1:1'].map(origin => ({ route: '/', headers: { Origin: origin } })),
    { route: '/', headers: { Host: 'untrusted.invalid' } },
    { route: '/', headers: { Upgrade: 'websocket', Connection: 'Upgrade' } },
  ];
  for (const { route, ...options } of probes) assert.equal((await http(route, options)).status, 403, `Forbidden preview route accepted: ${options.method || 'GET'} ${route}`);
  assert.equal(hash(await readFile(file)), originalHash, 'HTTP requests changed the document');
  // Authorized CLI editing still works independently of the read-only HTTP surface.
  await execute(executable, ['add', file, '/body', '--type', 'paragraph', '--prop', 'text=THOR_AUTHORIZED_CLI_EDIT', '--json'], { windowsHide: true, env, timeout: 30000 });
  await execute(executable, ['close', file, '--json'], { windowsHide: true, env, timeout: 30000 });
  assert.notEqual(hash(await readFile(file)), originalHash);
  console.log(JSON.stringify({ passed: true, executableSha256: asset.sha256, readOnlyPolicy: asset.source.policy, deniedHttpRequests: probes.length, originalUnchangedAfterHttp: true, authorizedCliEdit: true, browserCsrfTested: false }));
} finally {
  if (child.exitCode === null && child.pid) await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
}
