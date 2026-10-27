// A bounded pre-initialization barrier around the existing synthetic ACP fixture.
// It performs no remote operation and introduces no alternative host/runtime.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const state = process.env.THOR_MOCK_STATE_DIR;
if (!state || !path.isAbsolute(state)) throw new Error('Explicit synthetic state directory required.');
mkdirSync(state, { recursive: true });
const root = realpathSync(state);
const gate = process.env.THOR_RECOVERY_GATE_FILE;
if (gate && path.resolve(gate) !== path.join(root, 'before-initialize.gate')) throw new Error('Invalid synthetic initialization gate.');
if (gate && existsSync(gate)) {
  writeFileSync(path.join(root, 'gate-observed.json'), JSON.stringify({ stage: 'before-initialize', pid: process.pid }));
  const deadline = Date.now() + 60000;
  while (existsSync(gate)) {
    if (Date.now() > deadline) throw new Error('Synthetic initialization barrier expired.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
await import('./synthetic-acp.mjs');
