// Local acceptance evidence only. Never execute or generally unescape strings.
import path from 'node:path';
import assert from 'node:assert/strict';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This path is explicitly supplied by the probe caller. It is never launched
// here and never inferred from a commandActions payload or a machine default.
export async function describeCommandShell(filename) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename), 'Command shell must be an absolute ordinary file.');
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink() && (index === segments.length - 1 ? info.isFile() : info.isDirectory()),
      'Command shell and its parents must be ordinary files/directories, without links or junctions.');
  }
  const canonical = await realpath(absolute);
  assert.equal(process.platform === 'win32' ? canonical.toLowerCase() : canonical,
    process.platform === 'win32' ? absolute.toLowerCase() : absolute, 'Command shell must use its canonical path.');
  return { path: canonical, basename: path.basename(canonical), sha256: createHash('sha256').update(await readFile(canonical)).digest('hex') };
}

export const displayQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
// Reconstruct the segmented display observed in the CI10 Office capture. This
// forward transform is used only for whole-string correlation, not execution
// or arbitrary shell decoding. Its strategy matches local shlex 1.3's quoting
// implementation; the Codex build's exact renderer is not source-verified.
export function observedSegmentedQuote(value) {
  if (!value) return "''";
  let result = '', remaining = value;
  while (remaining.length) {
    let unquoted = true, single = true, double = true, length = 0;
    if (remaining[0] === '^') { unquoted = false; double = false; length = 1; }
    while (length < remaining.length) {
      const ch = remaining[length];
      const u = unquoted && /^[+./:@\]_a-zA-Z0-9-]$/.test(ch);
      const s = single && ch !== "'" && ch !== '^' && ch !== '\\';
      const d = double && !['`', '$', '!', '^'].includes(ch);
      if (!u && !s && !d) break;
      unquoted = u; single = s; double = d; length++;
    }
    if (!length) return null;
    const chunk = remaining.slice(0, length);
    result += unquoted ? chunk : single ? "'" + chunk + "'" : '"' + chunk.replace(/[\\"$`]/g, '\\$&') + '"';
    remaining = remaining.slice(length);
  }
  return result;
}
export function nativePowerShellCommand(input, expectedShell) {
  if (input?.type !== 'commandExecution' || typeof input.command !== 'string' || input.command.length > 1024 * 1024) return null;
  // Preserve the old bounded literal-command grammar; callers still parse it.
  if (input.command.trimStart().startsWith('& ')) return input.command;
  if (typeof expectedShell !== 'string' || !path.win32.isAbsolute(expectedShell)) return null;
  if (input.source !== 'unifiedExecStartup' || input.pluginId !== null || input.scriptPath !== null
      || !Array.isArray(input.commandActions) || input.commandActions.length !== 1) return null;
  const action = input.commandActions[0];
  if (action?.type !== 'unknown' || typeof action.command !== 'string' || !action.command.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.command)) return null;
  const match = /^("(?:[^"\\]|\\.)*") -Command /s.exec(input.command);
  if (!match) return null;
  let executable; try { executable = JSON.parse(match[1]); } catch { return null; }
  if (!/^[A-Za-z]:[\\/]/.test(executable) || /[\u0000-\u001f\u007f]/.test(executable)
      || path.win32.normalize(executable).toLowerCase() !== path.win32.normalize(expectedShell).toLowerCase()
      || path.win32.basename(executable).toLowerCase() !== 'pwsh.exe') return null;
  // Codex's observed display escapes slash/quote but keeps actual line breaks.
  // Correlate the whole display, including shell/options/body: no substring or
  // commandActions-only fallback can hide a prefix, suffix, or altered command.
  const prefix = `${displayQuote(executable)} -Command `;
  if (input.command !== prefix + displayQuote(action.command) && input.command !== prefix + observedSegmentedQuote(action.command)) return null;
  return action.command;
}
