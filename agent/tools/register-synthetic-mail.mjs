#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLocalCoreClient, registerSyntheticMail } from '../adapters/aioncore.mjs';

const { values } = parseArgs({ options: { 'core-url': { type: 'string' }, runtime: { type: 'string' }, 'server-path': { type: 'string' }, electron: { type: 'boolean', default: false } }, strict: true });
if (!values['core-url']) {
  process.stderr.write('Usage: node agent/tools/register-synthetic-mail.mjs --core-url http://127.0.0.1:PORT [--runtime /absolute/node] [--server-path /absolute/server.mjs] [--electron]\n');
  process.exitCode = 2;
} else {
  try {
    const api = createLocalCoreClient(values['core-url'], { headers: { ...(process.env.THOR_CORE_LOCAL_TOKEN ? { 'X-Thor-Local-Token': process.env.THOR_CORE_LOCAL_TOKEN } : {}), ...(process.env.THOR_CORE_AUTHORIZATION ? { Authorization: process.env.THOR_CORE_AUTHORIZATION } : {}), ...(process.env.THOR_CORE_CSRF ? { 'X-CSRF-Token': process.env.THOR_CORE_CSRF } : {}) } });
    const outcome = await registerSyntheticMail(api, { runtimeExecutable: values.runtime ?? process.execPath, serverPath: values['server-path'] ?? fileURLToPath(new URL('../../integrations/synthetic-mail/server.mjs', import.meta.url)), electronRuntime: values.electron });
    process.stdout.write(`${JSON.stringify({ synthetic: true, registered: true, serverId: outcome.server.id, name: outcome.server.name, toolNames: outcome.tools.map(tool => tool.name) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
