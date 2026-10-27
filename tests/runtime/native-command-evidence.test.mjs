import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePowerShellCommand, displayQuote, observedSegmentedQuote, describeCommandShell } from '../../agent/tools/native-command-evidence.mjs';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const observedPowerShellPath = String.raw`C:\Synthetic Tools\PowerShell\pwsh.exe`;
const wrap = raw => ({ type: 'commandExecution', source: 'unifiedExecStartup', pluginId: null, scriptPath: null,
  command: `${displayQuote(observedPowerShellPath)} -Command ${displayQuote(raw)}`, commandActions: [{ type: 'unknown', command: raw }] });

test('wrapped commands require an explicit expected shell and cannot infer it from their own display', () => {
  const input = wrap("& 'C:\\bundle\\node.exe' 'C:\\bundle\\memory.mjs' --action list");
  assert.equal(nativePowerShellCommand(input), null);
  assert.equal(nativePowerShellCommand(input, 'relative/pwsh.exe'), null);
  assert.equal(nativePowerShellCommand(input, String.raw`C:\Other\pwsh.exe`), null);
  assert.equal(nativePowerShellCommand(input, observedPowerShellPath), input.commandActions[0].command);
});

test('explicit ordinary shell evidence hashes bytes and reports its basename without executing it', async t => {
  const owned = await mkdtemp(path.join(tmpdir(), 'thor-command-shell-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const created = path.join(owned, 'pwsh.exe'), bytes = Buffer.from('synthetic shell identity, never executed');
  await writeFile(created, bytes);
  // tmpdir() can use a Windows 8.3 alias; the positive input must be canonical.
  const file = await realpath(created);
  const result = await describeCommandShell(file);
  assert.equal(result.basename, 'pwsh.exe');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(path.resolve(result.path).toLowerCase(), path.resolve(file).toLowerCase());
  await writeFile(file, 'changed synthetic shell identity');
  assert.notEqual((await describeCommandShell(file)).sha256, result.sha256);
});

test('shell preflight rejects directories, relative paths and links or junctions in the provided path', async t => {
  const owned = await mkdtemp(path.join(tmpdir(), 'thor-command-shell-links-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const target = path.join(owned, 'ordinary'), alias = path.join(owned, 'linked');
  await mkdir(target); await writeFile(path.join(target, 'pwsh.exe'), 'preserve synthetic target');
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(describeCommandShell(owned), /ordinary/);
  await assert.rejects(describeCommandShell('relative/pwsh.exe'), /absolute/);
  await assert.rejects(describeCommandShell(alias), /without links or junctions/);
  await assert.rejects(describeCommandShell(path.join(alias, 'pwsh.exe')), /without links or junctions/);
});
test('exact observed native display correlates single and multiple lines without executing them', () => {
  for (const raw of ["& 'C:\\bundle\\node.exe' 'C:\\bundle\\memory.mjs' --action list", "& 'C:\\bundle\\node.exe' 'one'\n& 'C:\\bundle\\node.exe' 'two'", '& $env:THOR_OFFICECLI_PATH set "C:\\work\\copy.docx"']) {
    assert.equal(nativePowerShellCommand(wrap(raw), observedPowerShellPath), raw);
  }
});
test('changed display, action, shell, options, multiple actions and control bytes reject', () => {
  const base = wrap("& 'C:\\bundle\\node.exe' 'memory.mjs' --action list");
  const bad = [
    { ...base, command: 'prefix ' + base.command }, { ...base, command: base.command + '; extra' },
    { ...base, command: base.command.replace(' -Command ', ' -NoProfile -Command ') },
    { ...base, command: base.command.replace('pwsh.exe', 'other.exe') },
    { ...base, commandActions: [{ type: 'unknown', command: 'different' }] },
    { ...base, commandActions: [...base.commandActions, ...base.commandActions] },
    { ...base, source: 'unknown' }, { ...base, pluginId: 'plugin' }, { ...base, scriptPath: 'file.ps1' },
    { ...base, commandActions: [{ type: 'read', command: base.commandActions[0].command }] }, wrap('bad\u0000command')
  ];
  for (const input of bad) assert.equal(nativePowerShellCommand(input, observedPowerShellPath), null);
});
test('normalizer does not make a shell operation safe or successful; downstream literal grammar remains required', () => {
  const raw = "Write-Output ok; & 'C:\\node.exe' 'memory.mjs'";
  assert.equal(nativePowerShellCommand(wrap(raw), observedPowerShellPath), raw);
  assert.equal(nativePowerShellCommand({ type: 'commandExecution', command: '& direct' }), '& direct');
});

test('the observed segmented Office wrapper requires exact whole-display/action correlation', () => {
  const raw = String.raw`& $env:THOR_OFFICECLI_PATH view 'outputs\01-overview.docx' screenshot --grid auto --render native -o "$env:TEMP\thor-office-copy1-word.png"`;
  const base = wrap(raw);
  base.command = `${displayQuote(observedPowerShellPath)} -Command ${observedSegmentedQuote(raw)}`;
  assert.equal(nativePowerShellCommand(base, observedPowerShellPath), raw);
  for (const bad of [
    { ...base, command: base.command + '; malicious' },
    { ...base, command: base.command.replace('01-overview', '02-operations') },
    { ...base, commandActions: [{ type: 'unknown', command: raw + '; extra' }] },
    { ...base, commandActions: [base.commandActions[0], base.commandActions[0]] },
    { ...base, command: base.command.replace('pwsh.exe', 'other.exe') },
    { ...base, source: 'other' }, { ...base, pluginId: 'plugin' },
  ]) assert.equal(nativePowerShellCommand(bad, observedPowerShellPath), null);
});
