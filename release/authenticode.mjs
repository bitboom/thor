import childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function signatureInvocation(filename, environment = process.env) {
  if (typeof filename !== 'string' || !path.win32.isAbsolute(filename)) throw new Error('Signature check requires an absolute Windows file path.');
  const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) throw new Error('Missing absolute Windows SystemRoot.');
  // A Node child of pwsh inherits PS7 module paths. Windows PowerShell cannot
  // load those modules; let this child construct its own defaults instead.
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const literal = filename.replaceAll("'", "''");
  const command = String.raw`$ErrorActionPreference = 'Stop'; Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath '${literal}' -ErrorAction Stop; [Console]::Out.WriteLine($signature.Status.ToString())`;
  return {
    command: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    options: { env, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

export function readAuthenticodeStatus(filename, environment = process.env) {
  if (process.platform !== 'win32') throw new Error('Authenticode verification requires Windows.');
  const invocation = signatureInvocation(filename, environment);
  const status = childProcess.execFileSync(invocation.command, invocation.args, invocation.options).trim();
  if (!/^[A-Za-z]+$/.test(status)) throw new Error('Signature command did not return a single status.');
  return status;
}

export function assertUnsignedInstaller(filename, environment = process.env) {
  const status = readAuthenticodeStatus(filename, environment);
  if (status !== 'NotSigned') throw new Error('Preview installer must have a verified unsigned Authenticode status.');
  return status;
}

export function signaturePreflight(environment = process.env) {
  if (process.platform !== 'win32') throw new Error('Authenticode verification requires Windows.');
  const parent = realpathSync(tmpdir()), directory = mkdtempSync(path.join(parent, 'thor-authenticode-'));
  const fixture = path.join(directory, 'unsigned-preflight.ps1');
  try {
    writeFileSync(fixture, '# Synthetic signature availability fixture; never executed.\n', { flag: 'wx' });
    assertUnsignedInstaller(fixture, environment);
  } finally {
    if (path.dirname(realpathSync(directory)).toLowerCase() !== parent.toLowerCase()) throw new Error('Signature preflight cleanup path escaped its owned temporary directory.');
    try { unlinkSync(fixture); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  }
  return { passed: true, policy: 'thor-authenticode-host-v1', synthetic: true, status: 'NotSigned',
    cleanupCompleted: true, actualInstallerChecked: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  const { values } = parseArgs({ options: { preflight: { type: 'boolean' } }, strict: true });
  if (!values.preflight) throw new Error('Usage: node release/authenticode.mjs --preflight');
  console.log(JSON.stringify(signaturePreflight()));
}
