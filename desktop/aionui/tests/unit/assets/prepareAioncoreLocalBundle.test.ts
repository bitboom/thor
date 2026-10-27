import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { prepareAioncore } = require('../../../packages/shared-scripts/src/prepare-aioncore');
afterEach(() => vi.unstubAllEnvs());

describe('prepare-aioncore local bundle input', () => {
  it('requires a supplied pinned bundle for Thor releases before resolving downloads', () => {
    vi.stubEnv('AIONUI_THOR_RELEASE', '1');
    vi.stubEnv('AIONUI_BACKEND_LOCAL_BUNDLE_DIR', '');
    expect(() => prepareAioncore({ projectRoot: 'unused', platform: 'win32', arch: 'x64', version: 'latest' })).toThrow(
      'explicit complete local Core bundle'
    );
  });

  it('refuses an upstream download fallback when a Thor release bundle is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'thor-missing-bundle-'));
    vi.stubEnv('AIONUI_THOR_RELEASE', '1');
    vi.stubEnv('AIONUI_BACKEND_RUN_ID', '');
    vi.stubEnv('AIONUI_BACKEND_LOCAL_BUNDLE_DIR', join(tmp, 'missing'));
    try {
      expect(() =>
        prepareAioncore({ projectRoot: join(tmp, 'project'), platform: 'win32', arch: 'x64', version: 'v0.2.2' })
      ).toThrow('refusing an upstream binary fallback');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records repository provenance without the source machine path for Thor releases', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'thor-private-bundle-'));
    const localBundle = join(tmp, 'bundle');
    const projectRoot = join(tmp, 'project');
    mkdirSync(join(localBundle, 'managed-resources/node/runtime'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore.exe'), 'fixture');
    writeFileSync(join(localBundle, 'managed-resources/node/runtime/node.exe'), 'fixture');
    writeFileSync(
      join(localBundle, 'managed-resources/manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        runtimeKey: 'win32-x64',
        node: { version: '24.11.0', root: 'node/runtime', executable: 'node.exe' },
        clis: [],
      })
    );
    vi.stubEnv('AIONUI_THOR_RELEASE', '1');
    vi.stubEnv('AIONUI_BACKEND_RUN_ID', '');
    vi.stubEnv('AIONUI_BACKEND_LOCAL_BUNDLE_DIR', localBundle);
    vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
    try {
      prepareAioncore({ projectRoot, platform: 'win32', arch: 'x64', version: 'v0.2.2' });
      const manifest = JSON.parse(
        readFileSync(join(projectRoot, 'resources/bundled-aioncore/win32-x64/manifest.json'), 'utf8')
      );
      expect(manifest.source).toEqual({
        repository: 'bitboom/thor',
        commit: 'a'.repeat(40),
        directory: 'host/aioncore',
      });
      expect(JSON.stringify(manifest)).not.toContain(tmp.replaceAll('\\', '\\\\'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hard fails local bundle input that lacks managed-resources manifest', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aionui-local-bundle-'));
    const projectRoot = join(tmp, 'project');
    const localBundle = join(tmp, 'bundle');
    mkdirSync(join(localBundle, 'managed-resources'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore.exe'), '');

    const previous = process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR;
    process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR = localBundle;
    try {
      expect(() =>
        prepareAioncore({
          projectRoot,
          platform: 'win32',
          arch: 'x64',
          version: 'v0.1.46',
        })
      ).toThrow(/managed-resources\/manifest\.json/);
    } finally {
      if (previous === undefined) delete process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR;
      else process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
