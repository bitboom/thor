import path from 'node:path';

const absolute = (value, name) => {
  if (typeof value !== 'string' || !(path.isAbsolute(value) || path.win32.isAbsolute(value)) || value.includes('\0')) throw new TypeError(`${name} must be an absolute path.`);
  return value;
};

/** Payload for AionCore v0.2.2 POST /api/mcp/servers/import (one entry). */
export function syntheticMailRegistration({ runtimeExecutable, serverPath, electronRuntime = false }) {
  return {
    name: 'thor_synthetic_mail',
    description: 'Invented mail and attachments with simulated allow/deny/expiry. No real enterprise connection.',
    transport: {
      type: 'stdio',
      command: absolute(runtimeExecutable, 'runtimeExecutable'),
      args: [absolute(serverPath, 'serverPath')],
      ...(electronRuntime ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    },
    enabled: true,
    builtin: false,
  };
}

/** Reuses the desktop's authenticated API client. Never calls CLI/global sync APIs. */
export async function registerSyntheticMail(api, options) {
  const registration = syntheticMailRegistration(options);
  const { enabled, builtin, description, ...connection } = registration;
  const test = await api.post('/api/mcp/test-connection', connection);
  if (!test?.success || !test.data?.success) throw new Error('Synthetic mail MCP connection test failed.');
  const names = new Set(test.data.tools?.map(tool => tool.name));
  if (!['mail_search', 'mail_read', 'mail_list_attachments', 'mail_authorize_attachment', 'mail_read_attachment', 'mail_reset_session'].every(name => names.has(name))) throw new Error('Synthetic mail MCP returned an incomplete tool catalog.');
  const response = await api.post('/api/mcp/servers/import', { servers: [registration] });
  const server = response?.data?.[0];
  if (!response?.success || typeof server?.id !== 'string' || server.enabled !== true || server.name !== registration.name) throw new Error('Synthetic mail MCP registration failed.');
  return { server, tools: test.data.tools };
}

/** Conversation-scoped MCP selection; Core maps this into native Codex config. */
export function codexConversation({ name = 'Synthetic mail review', workspace, mcpServerId }) {
  if (typeof mcpServerId !== 'string' || !mcpServerId || mcpServerId.length > 256) throw new TypeError('mcpServerId is required.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new TypeError('name must be 1–200 characters.');
  return { type: 'acp', name, extra: { backend: 'codex', workspace: absolute(workspace, 'workspace'), mcp_server_ids: [mcpServerId] } };
}

/** Minimal headless client for the existing local Core HTTP API, not a server. */
export function createLocalCoreClient(baseUrl, { headers = {}, timeoutMs = 30000 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new TypeError('Core URL must be a loopback HTTP(S) origin.');
  const request = async (method, route, body) => {
    if (typeof route !== 'string' || !route.startsWith('/api/') || route.startsWith('//') || route.includes('..')) throw new TypeError('Expected an /api/ route.');
    const response = await fetch(new URL(route, base), {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    // Do not echo response bodies: Core diagnostics can contain private paths or content.
    if (!response.ok) throw new Error(`Core request failed with HTTP ${response.status}.`);
    const value = await response.json();
    if (!value?.success) throw new Error('Core API returned a failed result.');
    return value;
  };
  return { get: route => request('GET', route), post: (route, body) => request('POST', route, body), patch: (route, body) => request('PATCH', route, body), delete: route => request('DELETE', route) };
}
