#!/usr/bin/env node
// An acceptance client for the installed Codex app-server; this is not a Thor host.
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { syntheticMailRegistration } from '../adapters/aioncore.mjs';

const { values } = parseArgs({ options: { codex: { type: 'string' }, workspace: { type: 'string' } }, strict: true });
if (!values.codex || !values.workspace) {
  process.stderr.write('Usage: node agent/tools/verify-codex-mcp.mjs --codex /absolute/codex --workspace /absolute/test-workspace\n');
  process.exitCode = 2;
} else {
  const registration = syntheticMailRegistration({ runtimeExecutable: process.execPath, serverPath: fileURLToPath(new URL('../../integrations/synthetic-mail/server.mjs', import.meta.url)) });
  const child = spawn(values.codex, ['app-server', '-c', 'mcp_servers={}'], { cwd: values.workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let id = 0;
  let buffer = '';
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', () => rejectAll(new Error('Codex app-server could not start.')));
  child.on('exit', () => rejectAll(new Error('Codex app-server exited before replying.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { rejectAll(new Error('Codex emitted invalid JSON.')); continue; }
      if (message.method && 'id' in message) {
        // No auth-token handling or silent permission grants in this test client.
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported acceptance-client request' } })}\n`);
      } else if ('id' in message) {
        const item = pending.get(message.id);
        if (!item) continue;
        clearTimeout(item.timer); pending.delete(message.id);
        if (message.error) item.reject(new Error(`Codex RPC failed with code ${message.error.code}.`));
        else item.resolve(message.result);
      }
    }
  });
  const request = (method, params = {}) => {
    const requestId = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Codex RPC timed out: ${method}`)); }, 30000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    return result;
  };
  let threadId;
  try {
    const init = await request('initialize', { clientInfo: { name: 'thor_acceptance', title: 'Thor Acceptance', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const account = await request('account/read', { refreshToken: false });
    const thread = await request('thread/start', { cwd: values.workspace, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'read-only', config: { mcp_servers: { [registration.name]: { command: registration.transport.command, args: registration.transport.args, startup_timeout_sec: 10, tool_timeout_sec: 15 } } } });
    threadId = thread.thread.id;
    const status = await request('mcpServerStatus/list', { threadId, serverName: registration.name, detail: 'toolsAndAuthOnly' });
    const server = status.data.find(item => item.name === registration.name);
    assert.ok(server, 'Synthetic MCP server missing from Codex inventory.');
    const names = Object.values(server.tools).map(item => item.name);
    assert.equal(names.length, 6, 'Codex did not discover all six synthetic mail tools.');
    const call = (tool, args = {}) => request('mcpServer/tool/call', { threadId, server: registration.name, tool, arguments: args });
    const search = await call('mail_search', { query: 'Lantern', limit: 1 });
    const searchBody = search.structuredContent ?? JSON.parse(search.content[0].text);
    assert.equal(searchBody.messages[0].id, 'msg-launch-001');
    const denied = await call('mail_read_attachment', { attachmentId: 'att-drm-denied' });
    const deniedBody = denied.structuredContent ?? JSON.parse(denied.content[0].text);
    assert.equal(deniedBody.error.code, 'ACCESS_DENIED');
    assert.equal(denied.isError, true);
    const publicFile = await call('mail_read_attachment', { attachmentId: 'att-launch-brief', encoding: 'base64' });
    const fileBody = publicFile.structuredContent ?? JSON.parse(publicFile.content[0].text);
    assert.match(Buffer.from(fileBody.content, 'base64').toString('utf8'), /Project Lantern/);
    process.stdout.write(`${JSON.stringify({ passed: true, runtime: 'installed-codex-app-server', clientVersion: init.userAgent?.match(/codex[^ ]*/i)?.[0] ?? 'reported-by-app-server', loggedIn: account.account !== null, authType: account.account?.type ?? null, discoveredToolCount: names.length, search: true, deniedAttachment: true, base64Attachment: true, wroteGlobalConfig: false, inferenceTurn: false })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    // Deliberately no raw stderr: it may contain account information or private paths.
    process.stderr.write(`Captured app-server diagnostic bytes: ${stderrBytes}; contents withheld.\n`);
    process.exitCode = 1;
  } finally {
    if (threadId && child.exitCode === null) await request('thread/unload', { threadId }).catch(() => {});
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(timer);
    }
  }
}
