import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { localBoundaryPolicy, validateCoreBoundaryProof } from './local-boundary-policy.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const { values } = parseArgs({ options: { bundle: { type: 'string' }, binary: { type: 'string' }, workspace: { type: 'string' }, evidence: { type: 'string' } }, strict: true });
if (!values.bundle || !values.workspace || !Object.values(values).every(value => path.isAbsolute(value))) throw new Error('Usage: node release/verify-core-local-boundary.mjs --bundle ABS_CORE_BUNDLE --workspace ABS_SYNTHETIC_DIRECTORY [--binary ABS_EXE] [--evidence ABS_JSON]');
const binary = values.binary || path.join(values.bundle, process.platform === 'win32' ? 'aioncore.exe' : 'aioncore');
const coreSha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
const run = path.join(values.workspace, `local-boundary-${randomUUID()}`);
await mkdir(run, { recursive: true });
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const trustedOrigin = 'http://localhost:5173';
const capability = randomBytes(32).toString('hex');
const wrongCapability = capability[0] === 'a' ? `b${capability.slice(1)}` : `a${capability.slice(1)}`;
const auth = { 'X-Thor-Local-Token': capability };
const proof = { schemaVersion: 1, policy: localBoundaryPolicy, passed: false, coreSha256, checks: {}, httpDeniedRequests: 0, wsDeniedRequests: 0 };
let stage = 'startup';
let check = 'authenticated readiness';
const sockets = new Set();
const child = spawn(binary, ['--local', '--host', '127.0.0.1', '--port', String(port), '--data-dir', path.join(run, 'data'), '--work-dir', path.join(run, 'workspace'), '--managed-resources-mode', 'bundled'], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, THOR_CORE_LOCAL_TOKEN: capability, THOR_CORE_TRUSTED_ORIGIN: trustedOrigin, AIONUI_BUNDLED_MANAGED_RESOURCES: path.join(values.bundle, 'managed-resources'), CODEX_SQLITE_HOME: path.join(run, 'codex-sqlite') },
});
let spawnFailed = false;
child.on('error', () => { spawnFailed = true; });
function http(route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: route, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, response => {
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) request.destroy(new Error('Oversized synthetic response')); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Synthetic request timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
function requireStatus(response, status, label) {
  if (response.status !== status) throw new Error(`Unexpected status for ${label}`);
  if (response.headers['access-control-allow-origin'] === '*') throw new Error('Wildcard CORS exposed local channel');
}
async function denyHttp(label, route, options, status) {
  check = label;
  const response = await http(route, options);
  requireStatus(response, status, label);
  if (response.headers['access-control-allow-origin']) throw new Error('Rejected request exposed a CORS origin');
  proof.httpDeniedRequests += 1;
}
function websocket(headers, expected, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, handshakeTimeout: 5000 });
    sockets.add(client);
    const timer = setTimeout(() => done(new Error('Synthetic WebSocket timeout')), 6000);
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.terminate();
      if (error) reject(error); else resolve();
    };
    client.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode !== expected || response.headers['access-control-allow-origin']) return done(new Error(`Unexpected rejected WebSocket status: ${label}`));
      done();
    });
    client.on('open', () => {
      if (expected !== 101) return done(new Error(`Unauthenticated WebSocket opened: ${label}`));
      client.ping('thor-synthetic-boundary');
    });
    client.on('pong', () => { if (expected === 101) done(); });
    client.on('message', data => { if (String(data).includes('realtime.error')) done(new Error('Authenticated WebSocket rejected after upgrade')); });
    client.on('error', () => { if (!settled) done(new Error(`WebSocket connection failed: ${label}`)); });
    client.on('close', () => { if (!settled) done(new Error(`WebSocket closed before policy result: ${label}`)); });
  });
}
try {
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null) throw new Error('Core exited before authenticated readiness');
    try { if ((await http('/health', { headers: auth })).status === 200) { ready = true; break; } } catch {}
    await pause(100);
  }
  if (!ready) throw new Error('Core did not become ready');
  proof.checks.httpAuthenticatedHealth = true;
  stage = 'HTTP boundary matrix';
  check = 'authenticated API';
  requireStatus(await http('/api/conversations?limit=1', { headers: auth }), 200, check);
  proof.checks.httpAuthenticatedApi = true;
  for (const rendererOrigin of [origin, 'null', trustedOrigin]) {
    const response = await http('/api/conversations?limit=1', { headers: { ...auth, Origin: rendererOrigin } });
    requireStatus(response, 200, 'authenticated renderer origin');
    if (response.headers['access-control-allow-origin'] !== rendererOrigin) throw new Error('Trusted CORS origin mismatch');
  }
  for (const route of ['/health', '/api/conversations?limit=1', '/api/agents/management', '/api/mcp/servers']) {
    await denyHttp('missing capability', route, {}, 401);
    await denyHttp('foreign origin without capability', route, { headers: { Origin: 'https://foreign.invalid' } }, 401);
  }
  proof.checks.httpMissingCapabilityRejected = true;
  await denyHttp('wrong capability', '/api/conversations', { headers: { 'X-Thor-Local-Token': wrongCapability } }, 401);
  proof.checks.httpWrongCapabilityRejected = true;
  for (const host of ['foreign.invalid', `foreign.invalid:${port}`, '127.0.0.1:1', 'localhost.evil.invalid']) await denyHttp('foreign host', '/api/conversations', { headers: { ...auth, Host: host, Origin: origin } }, 403);
  proof.checks.httpForeignHostRejected = true;
  for (const rendererOrigin of ['https://foreign.invalid', 'http://127.0.0.1:1', 'http://localhost:5174', 'file://', `${origin}/path`, 'null, https://foreign.invalid']) await denyHttp('foreign origin with capability', '/api/conversations', { headers: { ...auth, Origin: rendererOrigin } }, 403);
  proof.checks.httpForeignOriginRejected = true;
  await denyHttp('opaque origin without capability', '/api/conversations', { headers: { Origin: 'null' } }, 401);
  proof.checks.httpNullOriginRequiresCapability = true;
  await denyHttp('duplicate capability', '/health', { headers: { 'X-Thor-Local-Token': [capability, capability] } }, 401);
  proof.checks.httpDuplicateCapabilityRejected = true;
  await denyHttp('duplicate origin', '/health', { headers: { ...auth, Origin: [origin, origin] } }, 403);
  proof.checks.httpDuplicateOriginRejected = true;
  check = 'authenticated preflight';
  requireStatus(await http('/api/conversations', { method: 'OPTIONS', headers: { ...auth, Origin: origin, 'Access-Control-Request-Method': 'POST' } }), 204, check);
  proof.checks.httpAuthenticatedPreflight = true;
  await denyHttp('unauthenticated preflight', '/api/conversations', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-thor-local-token' } }, 401);
  proof.checks.httpUnauthenticatedPreflightRejected = true;
  proof.checks.httpNoWildcardCors = true;
  stage = 'WebSocket boundary matrix';
  check = 'authenticated WebSocket pong';
  for (const rendererOrigin of [undefined, origin, 'null', trustedOrigin]) await websocket({ ...auth, ...(rendererOrigin ? { Origin: rendererOrigin } : {}) }, 101, check);
  proof.checks.wsAuthenticatedPong = true;
  const deniedSockets = [
    ['wsMissingCapabilityRejected', {}, 401],
    ['wsMissingCapabilityRejected', { Origin: 'https://foreign.invalid' }, 401],
    ['wsWrongCapabilityRejected', { 'X-Thor-Local-Token': wrongCapability }, 401],
    ['wsForeignHostRejected', { ...auth, Host: `foreign.invalid:${port}`, Origin: origin }, 403],
    ['wsForeignOriginRejected', { ...auth, Origin: 'https://foreign.invalid' }, 403],
    ['wsForeignOriginRejected', { ...auth, Origin: 'http://127.0.0.1:1' }, 403],
    ['wsNullOriginRequiresCapability', { Origin: 'null' }, 401],
    ['wsDuplicateCapabilityRejected', { 'X-Thor-Local-Token': [capability, capability] }, 401],
    ['wsDuplicateOriginRejected', { ...auth, Origin: [origin, origin] }, 403],
  ];
  for (const [name, headers, status] of deniedSockets) {
    check = name;
    await websocket(headers, status, name);
    proof.wsDeniedRequests += 1;
    proof.checks[name] = true;
  }
  if (createHash('sha256').update(await readFile(binary)).digest('hex') !== coreSha256) throw new Error('Core bytes changed during policy verification');
  proof.passed = true;
  validateCoreBoundaryProof(proof, coreSha256);
  if (values.evidence) await writeFile(values.evidence, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} catch {
  console.error(JSON.stringify({ passed: false, policy: localBoundaryPolicy, coreSha256, stage, check }));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  if (child.exitCode === null && child.pid) {
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else child.kill('SIGKILL');
  }
}
