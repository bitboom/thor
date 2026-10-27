#!/usr/bin/env node
// Native Core/Codex acceptance; no result is successful before owned cleanup.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ProjectMemory } from '../memory-store.mjs';
import { createLocalCoreClient } from '../adapters/aioncore.mjs';
import { runCoreTurn } from '../client.mjs';
import { assertEntries, assertRecall, metadata, verifyMemoryToolCalls, memoryDigest, assertMayStart, stopMemoryCore } from './memory-verification.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = 'Usage: node agent/tools/verify-memory.mjs --core ABS_CORE --codex ABS_CODEX --bundle ABS_BUNDLE --repo ABS_REPO --state-root ABS_NEW_DIRECTORY --evidence ABS_NEW_JSON [--restarts 1..5]\n';
async function fresh(filename) {
  try { await lstat(filename); throw Error('Acceptance state/evidence must not already exist.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function childPath(root, relative) {
  assert.ok(typeof relative === 'string' && relative && !path.isAbsolute(relative));
  assert.ok(relative.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'));
  return path.join(root, relative);
}
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function memoryFileHash(memory) {
  try { return memoryDigest(await readFile(memory.filePath)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Exported solely for the separate, bounded automatic-policy acceptance probe.
// It is not an agent host or a product memory implementation.
export async function createMemoryAcceptance(options) {
  for (const name of ['core', 'codex', 'bundle', 'repo', 'state-root', 'evidence']) assert.ok(options[name] && path.isAbsolute(options[name]));
  assert.equal(process.platform, 'win32'); assert.match(path.basename(options.codex), /^codex\.exe$/i);
  await fresh(options['state-root']); await fresh(options.evidence);
  const managed = await realpath(path.join(options.bundle, 'managed-resources'));
  const manifestBytes = await readFile(path.join(managed, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.schemaVersion, 2);
  const node = childPath(childPath(managed, manifest.node.root), manifest.node.executable);
  assert.ok((await realpath(node)).toLowerCase().startsWith(managed.toLowerCase() + path.sep));
  const cli = path.join(managed, 'thor-agent/tools/memory.mjs');
  const store = path.join(managed, 'thor-agent/memory-store.mjs');
  const hashes = Object.fromEntries(await Promise.all(Object.entries({ core: options.core, codex: options.codex, node, cli, store,
    policySource: path.join(options.repo, 'host/aioncore/crates/aionui-ai-agent/src/project_memory_policy.rs'),
  }).map(async ([key, file]) => [key, memoryDigest(await readFile(file))])));
  assert.equal(hashes.cli, memoryDigest(await readFile(path.join(options.repo, 'agent/tools/memory.mjs'))));
  assert.equal(hashes.store, memoryDigest(await readFile(path.join(options.repo, 'agent/memory-store.mjs'))));
  assert.equal(hashes.store, memoryDigest(await readFile(new URL('../memory-store.mjs', import.meta.url))));
  const commit = (await execute('git', ['-C', options.repo, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  const dirty = Boolean((await execute('git', ['-C', options.repo, 'status', '--porcelain'], { windowsHide: true })).stdout.trim());
  const codexVersion = (await execute(options.codex, ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim();
  assert.match(codexVersion, /^codex-cli [A-Za-z0-9.+-]+$/);
  // Atomic mkdir, not an empty-memory check: even an empty existing state is refused.
  await mkdir(options['state-root']);
  const root = await realpath(options['state-root']), nonce = randomUUID();
  const owner = path.join(root, 'SYNTHETIC-MEMORY-OWNER');
  await writeFile(owner, nonce, { flag: 'wx' });
  const workspaceA = path.join(root, 'project-a'), workspaceB = path.join(root, 'project-b'), data = path.join(root, 'data');
  await mkdir(workspaceA); await mkdir(workspaceB); await mkdir(data);
  const runner = {
    child: undefined, api: undefined, cleanupVerified: false, root, workspaceA, workspaceB, node, cli,
    memoryA: new ProjectMemory(workspaceA), memoryB: new ProjectMemory(workspaceB), pending: [], durableTurns: 0,
    source: { coreSha256: hashes.core, requestedCodexSha256: hashes.codex, codexVersion,
      bundledNodeSha256: hashes.node, bundledMemoryCliSha256: hashes.cli, bundledMemoryStoreSha256: hashes.store,
      managedManifestSha256: memoryDigest(manifestBytes), policySourceSha256: hashes.policySource,
      observedCheckoutCommit: commit, observedCheckoutDirty: dirty, binaryToCheckoutBindingVerified: false },
    async assertOwner() { assert.equal(await readFile(owner, 'utf8'), nonce); },
    async start() {
      await this.assertOwner(); assertMayStart(this.child); this.cleanupVerified = false;
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const token = randomBytes(32).toString('hex'), env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(PATH|CODEX_SQLITE_HOME|AIONUI_BUNDLED_MANAGED_RESOURCES|THOR_CORE_LOCAL_TOKEN|THOR_CORE_TRUSTED_ORIGIN|THOR_OFFICECLI_.*|OFFICECLI_.*)$/i.test(key)) delete env[key];
      Object.assign(env, { THOR_CORE_LOCAL_TOKEN: token, AIONUI_BUNDLED_MANAGED_RESOURCES: managed,
        CODEX_SQLITE_HOME: path.join(root, 'codex-sqlite'), PATH: [path.dirname(options.codex), path.dirname(node), process.env.PATH ?? ''].join(path.delimiter) });
      this.child = spawn(options.core, ['--local', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data,
        '--work-dir', workspaceA, '--parent-pid', String(process.pid), '--managed-resources-mode', 'bundled', '--log-level', 'error'], { windowsHide: true, stdio: 'ignore', env });
      let failed = false; this.child.once('error', () => { failed = true; });
      this.api = createLocalCoreClient(`http://127.0.0.1:${port}`, { headers: { 'X-Thor-Local-Token': token } });
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (failed || this.child.exitCode !== null || this.child.signalCode !== null) throw Error('Owned Core exited before readiness.');
        try { await this.api.get('/api/conversations?limit=1'); return; } catch { await pause(100); }
      }
      throw Error('Owned Core readiness was not confirmed.');
    },
    async turn(workspace, prompt, requirements) {
      await this.assertOwner(); assert.ok([workspaceA, workspaceB].includes(workspace));
      const id = (await this.api.post('/api/conversations', { type: 'acp', name: 'Synthetic project memory acceptance',
        extra: { backend: 'codex', workspace, mcp_server_ids: [] } })).data.id;
      const getRows = async () => {
        const page = (await this.api.get(`/api/conversations/${encodeURIComponent(id)}/messages?limit=200`)).data;
        assert.equal(page.has_more_before, false); assert.equal(page.has_more_after, false); return page.items;
      };
      assert.equal((await getRows()).length, 0);
      const turn = await runCoreTurn(this.api, { conversationId: id, content: prompt, timeoutMs: 300000 });
      assert.ok(typeof turn.turnId === 'string' && turn.turnId.trim());
      const wanted = await requirements(turn);
      const context = { node, cli, workspace }; let proof;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try { proof = verifyMemoryToolCalls(await getRows(), context, wanted, turn.turnId); break; } catch { await pause(100); }
      }
      assert.ok(proof, 'Native bundled memory CLI proof was not confirmed.');
      this.pending.push({ conversationId: id, turnId: turn.turnId, context, wanted, proof });
      return { turn, proof };
    },
    async stop() {
      await this.assertOwner();
      if (!this.child) return;
      await stopMemoryCore(this.child, child => execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }), pause);
      this.child = undefined; this.cleanupVerified = true;
    },
    async verifyStoppedSqlite() {
      assertMayStart(this.child); assert.ok(this.cleanupVerified); await this.assertOwner();
      const filename = await realpath(path.join(data, 'aionui-backend.db'));
      assert.ok(filename.toLowerCase().startsWith(root.toLowerCase() + path.sep));
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        for (const record of this.pending) {
          const rows = db.prepare('SELECT id,type,status,position,content FROM messages WHERE conversation_id=?').all(record.conversationId);
          assert.deepEqual(verifyMemoryToolCalls(rows, record.context, record.wanted, record.turnId), record.proof);
          this.durableTurns++;
        }
        this.pending = [];
      } finally { db.close(); }
    },
  };
  return runner;
}

const operation = (args, output) => ({ args, output });
export async function verifyMemoryAcceptance(options) {
  let runner, stage = 'preflight', failure = null;
  const proof = { schemaVersion: 2, passed: false, synthetic: true, cases: {},
    memoryMechanism: 'agent instructions plus project-owned CLI/file; no host fact extractor',
    automaticStableFactRetentionTested: false, memoryMcpImplemented: false,
    independentCommandExitCodeObserved: false, nativeToolContract: 'Core-mapped completed commandExecution invoking exact bundled CLI with bound workspace and successful JSON output',
    installedDesktop: false, automaticPermissionGrants: false };
  try {
    const restarts = Number(options.restarts ?? '5'); assert.ok(Number.isInteger(restarts) && restarts >= 1 && restarts <= 5);
    runner = await createMemoryAcceptance(options); Object.assign(proof, runner.source);
    const nonce = randomUUID().replaceAll('-', '');
    const facts = Array.from({ length: 20 }, (_, index) => ({ id: `fact-${index}`, title: `Synthetic project preference ${index}`,
      source: `Synthetic user preference statement ${index}`, origin: 'user', mode: 'explicit', content: `Synthetic value ${nonce}-${index}.` }));
    const updated = facts.slice(0, 5).map(fact => ({ ...fact, content: `Updated ${fact.content}`, source: `Synthetic user update statement ${fact.id}` }));
    const deleted = facts.slice(5, 10).map(fact => fact.id).sort(); const retained = [...updated, ...facts.slice(10)];
    const direct = 'Use only the bundled project-memory CLI from the session policy. For verifiable calls, invoke the absolute Node and memory.mjs paths directly with literal --workspace/--action/entry arguments; use separate direct invocations or semicolon/newline-separated invocations, not loops, aliases, variables, command wrappers, or another file editor. Existing permissions apply; do not grant approvals, install tools, change global configuration or access another project.';
    stage = 'initial-Core-start'; await runner.start();
    stage = 'explicit-twenty-saves';
    await runner.turn(runner.workspaceA, `${direct} Explicitly save these twenty user-provided project facts, with every listed field: ${JSON.stringify(facts)}. Reply THOR_MEMORY_SAVED_20 after success.`, async turn => {
      assert.ok(turn.assistantText.includes('THOR_MEMORY_SAVED_20')); assertEntries(await runner.memoryA.read(), facts);
      return facts.map(fact => operation({ action: 'save', ...fact }, { saved: true, updated: false, id: fact.id, file: 'THOR_MEMORY.md' }));
    });
    stage = 'five-updates-five-deletions';
    await runner.turn(runner.workspaceA, `${direct} Explicitly update these five existing entries ${JSON.stringify(updated)} and delete exactly these five IDs ${JSON.stringify(deleted)}. Preserve all others. Reply THOR_MEMORY_EDITED after success.`, async turn => {
      assert.ok(turn.assistantText.includes('THOR_MEMORY_EDITED')); assertEntries(await runner.memoryA.read(), retained, deleted);
      return [...updated.map(fact => operation({ action: 'save', ...fact }, { saved: true, updated: true, id: fact.id, file: 'THOR_MEMORY.md' })),
        ...deleted.map(id => operation({ action: 'delete', id }, { deleted: true, id, file: 'THOR_MEMORY.md' }))];
    });
    const stableHash = await memoryFileHash(runner.memoryA);
    stage = 'separate-project-isolation';
    await runner.turn(runner.workspaceB, `${direct} This is a separate empty synthetic project. List its project-memory metadata only. Reply exactly THOR_EMPTY_PROJECT_MEMORY if empty. Do not read another project or change files.`, async turn => {
      assert.ok(turn.assistantText.includes('THOR_EMPTY_PROJECT_MEMORY')); assert.equal((await runner.memoryB.read()).length, 0);
      assert.equal(await memoryFileHash(runner.memoryA), stableHash);
      return [operation({ action: 'list' }, { file: 'THOR_MEMORY.md', entries: [] })];
    });
    await runner.stop(); await runner.verifyStoppedSqlite();
    for (let restart = 1; restart <= restarts; restart++) {
      stage = `restart-${restart}-recall`; await runner.start();
      assertEntries(await runner.memoryA.read(), retained, deleted); assert.equal(await memoryFileHash(runner.memoryA), stableHash);
      await runner.turn(runner.workspaceA, `${direct} Read this project's current memory metadata and facts fact-0 through fact-4 and fact-10 through fact-19. Verify fact-5 through fact-9 are absent using the list, without attempting failing reads. Do not change files or use another conversation's transcript. Reply only JSON with exactly {"facts":{ID:exact_current_content,...},"missing":[absent IDs sorted lexically]}.`, async turn => {
        const entries = await runner.memoryA.read(); assertEntries(entries, retained, deleted); assertRecall(turn.assistantText, entries, deleted);
        assert.equal(await memoryFileHash(runner.memoryA), stableHash); assert.equal((await runner.memoryB.read()).length, 0);
        for (const id of deleted) await assert.rejects(runner.memoryA.get(id), { code: 'NOT_FOUND' });
        return [operation({ action: 'list' }, { file: 'THOR_MEMORY.md', entries: metadata(entries) }),
          ...entries.map(entry => operation({ action: 'read', id: entry.id }, { entry }))];
      });
      await runner.stop(); await runner.verifyStoppedSqlite();
    }
    assert.ok(runner.cleanupVerified && !runner.child);
    proof.cases.explicit = { passed: true, saved: 20, updated: 5, deleted: 5, restarts,
      currentValuesRecheckedEachRestart: 15, deletedIdsRecheckedEachRestart: 5, freshConversationEachRecall: true };
    proof.cases.projectIsolation = { passed: true, separateProjectEmpty: true, projectAUnchanged: true,
      scope: 'separate project-file selection and no automatic carryover; not a sandbox isolation guarantee' };
    proof.durableNativeTurnsVerified = runner.durableTurns; proof.ownedProcessTreeStopped = true;
    proof.closedCoreSqliteReadback = true; proof.completedAt = new Date().toISOString(); proof.passed = true;
  } catch { failure = stage; }
  finally {
    if (runner?.child) { try { await runner.stop(); } catch { failure = 'owned-Core-cleanup-unproven'; } }
  }
  if (failure) { proof.passed = false; proof.inconclusiveAt = failure; proof.ownedProcessTreeStopped = runner?.cleanupVerified === true; }
  if (options.evidence && path.isAbsolute(options.evidence)) await writeFile(options.evidence, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  return proof;
}

if (process.argv[1] && equal(pathToFileURL(path.resolve(process.argv[1])).href, import.meta.url)) {
  const { values } = parseArgs({ options: { core: { type: 'string' }, codex: { type: 'string' }, bundle: { type: 'string' }, repo: { type: 'string' }, 'state-root': { type: 'string' }, evidence: { type: 'string' }, restarts: { type: 'string', default: '5' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) process.stdout.write(usage);
  else try { const proof = await verifyMemoryAcceptance(values); process.stdout.write(JSON.stringify(proof) + '\n'); if (!proof.passed) process.exitCode = 1; }
  catch { process.stderr.write(JSON.stringify({ passed: false, inconclusiveAt: 'arguments-or-evidence-write' }) + '\n'); process.exitCode = 1; }
}
