#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ProjectMemory, MemoryError } from '../memory-store.mjs';

try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, action: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, source: { type: 'string' }, origin: { type: 'string' }, mode: { type: 'string' }, content: { type: 'string' } }, strict: true });
  const memory = new ProjectMemory(values.workspace);
  let result;
  if (values.action === 'list') result = { file: 'THOR_MEMORY.md', entries: await memory.list() };
  else if (values.action === 'read') result = { entry: await memory.get(values.id) };
  else if (values.action === 'save') result = await memory.save(values);
  else if (values.action === 'delete') result = await memory.delete(values.id);
  else if (values.action === 'recover') result = await memory.recover();
  else throw new MemoryError('INVALID_ARGUMENT', 'action must be list, read, save, delete, or recover.');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Do not echo raw OS errors, caller arguments, or private file content.
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof MemoryError ? error.code : 'IO_ERROR', message: error instanceof MemoryError ? error.message : 'Memory operation failed; inspect the workspace file and permissions.' } })}\n`);
  process.exitCode = 1;
}
