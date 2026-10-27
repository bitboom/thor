import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMailService } from '../../integrations/synthetic-mail/mail-service.mjs';

const serverPath = fileURLToPath(new URL('../../integrations/synthetic-mail/server.mjs', import.meta.url));

class Client {
  constructor() {
    this.child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.id = 0;
    this.stderr = '';
    this.buffer = '';
    this.unsolicited = [];
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch (error) { for (const item of this.pending.values()) item.reject(error); return; }
        const item = this.pending.get(message.id);
        if (item) { clearTimeout(item.timer); this.pending.delete(message.id); item.resolve(message); }
        else this.unsolicited.push(message);
      }
    });
    this.child.on('error', error => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } });
    this.child.on('exit', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Server exited before replying')); } });
  }
  request(method, params = {}) {
    const id = ++this.id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async initialize(version = '2025-11-25') {
    const reply = await this.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'thor-protocol-test', version: '1.0.0' } });
    assert.equal(reply.error, undefined);
    this.notify('notifications/initialized');
    return reply.result;
  }
  async call(name, args = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
    return reply.result;
  }
  async close() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise(resolve => this.child.once('exit', resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2000);
    await exited;
    clearTimeout(timer);
    assert.equal(this.stderr, '');
  }
}

const withClient = async run => {
  const client = new Client();
  try { await run(client); } finally { await client.close(); }
};

test('real stdio lifecycle, version negotiation, fixed tool discovery and protocol errors', () => withClient(async client => {
  assert.equal((await client.request('tools/list')).error.code, -32000);
  assert.deepEqual((await client.request('ping')).result, {});
  const init = await client.initialize();
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.equal(init.serverInfo.name, 'thor-synthetic-mail');
  assert.match(init.instructions, /SYNTHETIC DEMO ONLY/);
  const catalog = (await client.request('tools/list')).result.tools;
  assert.equal(catalog.length, 6);
  assert.equal(new Set(catalog.map(item => item.name)).size, 6);
  assert.ok(catalog.every(item => item.inputSchema.additionalProperties === false && item.annotations.openWorldHint === false));
  assert.equal((await client.request('tools/list', { cursor: 'bad' })).error.code, -32602);
  assert.equal((await client.request('tools/call', { name: 'does_not_exist' })).error.code, -32602);
  assert.equal((await client.request('resources/read', { uri: 'file:///anything' })).error.code, -32601);
  assert.equal((await client.request('initialize', {})).error.code, -32600);
}));

test('real stdio search uses stable pagination and rejects mismatched or malformed cursors', () => withClient(async client => {
  await client.initialize('2024-11-05');
  const first = (await client.call('mail_search', { limit: 2 })).structuredContent;
  assert.deepEqual(first.messages.map(item => item.id), ['msg-launch-001', 'msg-budget-002']);
  assert.equal(first.total, 4);
  assert.ok(first.nextCursor);
  const second = (await client.call('mail_search', { limit: 2, cursor: first.nextCursor })).structuredContent;
  assert.deepEqual(second.messages.map(item => item.id), ['msg-drm-003', 'msg-notes-004']);
  assert.equal(second.nextCursor, null);
  assert.equal((await client.call('mail_search', { query: 'Lantern', cursor: first.nextCursor })).structuredContent.error.code, 'INVALID_CURSOR');
  assert.equal((await client.call('mail_search', { cursor: 'not-base64' })).structuredContent.error.code, 'INVALID_CURSOR');
  const matched = (await client.call('mail_search', { query: 'LANTERN', label: 'budget' })).structuredContent;
  assert.equal(matched.messages.length, 1);
  assert.equal(matched.messages[0].id, 'msg-budget-002');
  assert.equal((await client.call('mail_search', { query: 'no such synthetic message' })).structuredContent.total, 0);
}));

test('real stdio reads messages, metadata, public text/base64 attachments and checksums', () => withClient(async client => {
  await client.initialize();
  const message = (await client.call('mail_read', { messageId: 'msg-launch-001' })).structuredContent;
  assert.match(message.body, /18 April 2030/);
  assert.equal(message.attachments.length, 2);
  const listed = (await client.call('mail_list_attachments', { messageId: message.id })).structuredContent;
  assert.deepEqual(listed.attachments, message.attachments);
  const content = (await client.call('mail_read_attachment', { attachmentId: 'att-launch-brief', encoding: 'base64' })).structuredContent;
  const bytes = Buffer.from(content.content, 'base64');
  assert.match(bytes.toString('utf8'), /Project Lantern/);
  assert.equal(content.size, bytes.length);
  assert.equal(content.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await client.call('mail_list_attachments', { messageId: 'msg-notes-004' })).structuredContent.attachments.length, 0);
}));

test('real stdio simulated allow/deny/expire cannot be bypassed with a different tool or token', () => withClient(async client => {
  await client.initialize();
  assert.equal((await client.call('mail_read_attachment', { attachmentId: 'att-budget-allowed' })).structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  const allowed = (await client.call('mail_authorize_attachment', { attachmentId: 'att-budget-allowed', ttlSeconds: 60 })).structuredContent;
  assert.equal(allowed.protection.status, 'authorized');
  assert.equal((await client.call('mail_read_attachment', { attachmentId: allowed.id, authorization: 'invented-wrong-token' })).structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  assert.match((await client.call('mail_read_attachment', { attachmentId: allowed.id, authorization: allowed.authorization })).structuredContent.content, /1500/);
  const denied = await client.call('mail_authorize_attachment', { attachmentId: 'att-drm-denied' });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'ACCESS_DENIED');
  assert.equal((await client.call('mail_read_attachment', { attachmentId: 'att-drm-denied', authorization: allowed.authorization })).structuredContent.error.code, 'ACCESS_DENIED');
  const temporary = (await client.call('mail_authorize_attachment', { attachmentId: 'att-drm-expiring', ttlSeconds: 300 })).structuredContent;
  assert.match((await client.call('mail_read_attachment', { attachmentId: temporary.id, authorization: temporary.authorization })).structuredContent.content, /2030-04-19/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await client.call('mail_read_attachment', { attachmentId: temporary.id, authorization: temporary.authorization })).structuredContent.error.code, 'AUTHORIZATION_EXPIRED');
  const metadata = (await client.call('mail_list_attachments', { messageId: 'msg-drm-003' })).structuredContent.attachments;
  assert.equal(metadata.find(item => item.id === temporary.id).protection.status, 'expired');
  assert.ok(metadata.every(item => !('text' in item) && !('content' in item)));
  await client.call('mail_reset_session');
  assert.equal((await client.call('mail_read_attachment', { attachmentId: allowed.id, authorization: allowed.authorization })).structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
}));

test('tool arguments reject traversal, invalid types, excessive limits and unknown properties', () => withClient(async client => {
  await client.initialize();
  const cases = [
    ['mail_read', { messageId: '../../private-file' }, 'NOT_FOUND'],
    ['mail_read', { messageId: null }, 'INVALID_ARGUMENT'],
    ['mail_read', {}, 'INVALID_ARGUMENT'],
    ['mail_read_attachment', { attachmentId: 'att-launch-brief', path: 'private-file' }, 'INVALID_ARGUMENT'],
    ['mail_read_attachment', { attachmentId: 'att-launch-brief', encoding: 'exe' }, 'INVALID_ARGUMENT'],
    ['mail_search', { limit: 51 }, 'INVALID_ARGUMENT'],
    ['mail_search', { limit: 1.5 }, 'INVALID_ARGUMENT'],
    ['mail_search', [], 'INVALID_ARGUMENT'],
    ['mail_authorize_attachment', { attachmentId: 'att-budget-allowed', ttlSeconds: 0 }, 'INVALID_ARGUMENT'],
  ];
  for (const [name, args, code] of cases) {
    const reply = await client.call(name, args);
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.error.code, code);
  }
}));

test('separate MCP processes cannot share authorization grants', async () => {
  let previous;
  await withClient(async client => {
    await client.initialize();
    previous = (await client.call('mail_authorize_attachment', { attachmentId: 'att-budget-allowed' })).structuredContent.authorization;
  });
  await withClient(async client => {
    await client.initialize();
    assert.equal((await client.call('mail_read_attachment', { attachmentId: 'att-budget-allowed', authorization: previous })).structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  });
});

test('malformed JSON is a protocol parse error and subsequent valid requests still work', () => withClient(async client => {
  client.child.stdin.write('{malformed-json}\n');
  await client.request('ping');
  assert.equal(client.unsolicited[0].error.code, -32700);
  assert.equal(client.unsolicited[0].id, null);
}));

test('simulated authorization boundary is exact at expiry', () => {
  let instant = 10000;
  const service = createMailService({ now: () => instant });
  const grant = service.call('mail_authorize_attachment', { attachmentId: 'att-drm-expiring' });
  instant = 10999;
  assert.ok(service.call('mail_read_attachment', { attachmentId: grant.id, authorization: grant.authorization }).content);
  instant = 11000;
  assert.throws(() => service.call('mail_read_attachment', { attachmentId: grant.id, authorization: grant.authorization }), { code: 'AUTHORIZATION_EXPIRED' });
});
