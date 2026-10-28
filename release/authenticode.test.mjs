import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, unlinkSync, rmdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signatureInvocation, readAuthenticodeStatus, assertUnsignedInstaller, signaturePreflight } from './authenticode.mjs';

test('signature child uses the system host and own module, removing every inherited module-path casing only in its copy', () => {
  const environment = { SystemRoot: 'C:\\Windows', PSModulePath: 'incompatible-core', psmodulepath: 'another-case', Path: 'keep-path', OTHER: 'keep-value' };
  const invocation = signatureInvocation(String.raw`C:\synthetic\quote's $file.ps1`, environment);
  assert.equal(invocation.command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(invocation.options.env, { SystemRoot: 'C:\\Windows', Path: 'keep-path', OTHER: 'keep-value' });
  assert.equal(environment.PSModulePath, 'incompatible-core');
  assert.equal(environment.psmodulepath, 'another-case');
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(invocation.args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(String.raw`Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'`));
  assert.ok(script.includes(String.raw`Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath 'C:\synthetic\quote''s $file.ps1' -ErrorAction Stop`));
  assert.ok(!script.includes('Bypass') && !invocation.args.includes('-ExecutionPolicy'));
  assert.equal(invocation.options.timeout, 30000);
});

test('signature invocation rejects relative files and missing system-root identity', () => {
  assert.throws(() => signatureInvocation('relative.exe', { SystemRoot: 'C:\\Windows' }), /absolute/);
  assert.throws(() => signatureInvocation('C:\\absolute.exe', {}), /SystemRoot/);
});

test('only exact NotSigned qualifies as an unsigned preview and malformed output cannot substitute', { skip: process.platform !== 'win32' }, t => {
  let output = 'NotSigned\r\n';
  t.mock.method(childProcess, 'execFileSync', () => output);
  assert.equal(assertUnsignedInstaller('C:\\synthetic.exe'), 'NotSigned');
  for (output of ['Valid', 'NotTrusted', 'HashMismatch', 'UnknownError', 'Incompatible', 'NotSupportedFileFormat', 'Bogus']) {
    assert.throws(() => assertUnsignedInstaller('C:\\synthetic.exe'), /verified unsigned/);
  }
  for (output of ['', 'NotSigned\nValid', 'NotSigned extra']) assert.throws(() => assertUnsignedInstaller('C:\\synthetic.exe'), /single status/);
});

test('signature process failure and timeout propagate instead of being treated as unsigned', { skip: process.platform !== 'win32' }, t => {
  let fault;
  t.mock.method(childProcess, 'execFileSync', () => { throw fault; });
  for (const code of ['ENOENT', 'ETIMEDOUT', 'CHILD_EXIT_1']) {
    fault = Object.assign(new Error('Synthetic signature process failure'), { code });
    assert.throws(() => assertUnsignedInstaller('C:\\synthetic.exe'), error => error === fault);
  }
});

test('real Windows query survives an incompatible inherited module path and rejects the signed system host', { skip: process.platform !== 'win32' }, () => {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'thor-signature-test-'));
  const file = path.join(directory, "unsigned ' literal.ps1");
  const environment = { ...process.env, PSModulePath: 'C:\\synthetic-missing-modules', psmodulepath: 'C:\\another-missing-modules' };
  try {
    writeFileSync(file, "throw 'Synthetic file must never be executed'\n", { flag: 'wx' });
    assert.equal(assertUnsignedInstaller(file, environment), 'NotSigned');
    const host = signatureInvocation(file, environment).command;
    assert.notEqual(readAuthenticodeStatus(host, environment), 'NotSigned');
    assert.throws(() => assertUnsignedInstaller(host, environment), /verified unsigned/);
    assert.equal(signaturePreflight(environment).cleanupCompleted, true);
  } finally {
    assert.equal(path.dirname(realpathSync(directory)).toLowerCase(), parent.toLowerCase());
    unlinkSync(file); rmdirSync(directory);
  }
});

test('preflight runs from an isolated Node-only copy before repository dependencies exist', { skip: process.platform !== 'win32' }, () => {
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'thor-signature-isolated-'));
  const script = path.join(directory, 'authenticode.mjs');
  try {
    copyFileSync(new URL('./authenticode.mjs', import.meta.url), script);
    const output = childProcess.execFileSync(process.execPath, [script, '--preflight'], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 40000,
      env: { ...process.env, NODE_PATH: '', PSModulePath: 'C:\\synthetic-missing-modules' },
    });
    assert.deepEqual(JSON.parse(output), { passed: true, policy: 'thor-authenticode-host-v1', synthetic: true,
      status: 'NotSigned', cleanupCompleted: true, actualInstallerChecked: false });
  } finally {
    assert.equal(path.dirname(realpathSync(directory)).toLowerCase(), parent.toLowerCase());
    unlinkSync(script); rmdirSync(directory);
  }
});
