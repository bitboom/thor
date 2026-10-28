import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseIdentityCapture } from '../../packages/web-host/src/database-identity';
import {
  coreRequestHeaders,
  createIdentityExporter,
  installCoreMainFetch,
  isCoreTarget,
  isTrustedDevDocument,
  trustedCoreRequest,
  trustedIdentitySender,
  writeIdentityExclusive,
} from '@/process/startup/coreTransport';

describe('local identity export', () => {
  it('never overwrites an existing selected file', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.identity-test-'));
    const target = path.join(directory, 'diagnostic.json');
    try {
      await writeFile(target, 'existing');
      await expect(writeIdentityExclusive(target, 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(target, 'utf8')).toBe('existing');
    } finally {
      await unlink(target);
      await rmdir(directory);
    }
  });
  it('accepts only the current trusted main document', () => {
    const trustedDocuments = ['file:///C:/thor/renderer/index.html'];
    const state = {
      currentWindow: true,
      currentSender: true,
      mainFrame: true,
      frameUrl: `${trustedDocuments[0]}#/settings`,
      trustedDocuments,
    };
    expect(trustedIdentitySender(state)).toBe(true);
    expect(trustedIdentitySender({ ...state, currentSender: false })).toBe(false);
    expect(trustedIdentitySender({ ...state, mainFrame: false })).toBe(false);
    expect(trustedIdentitySender({ ...state, frameUrl: 'https://example.com/' })).toBe(false);
    expect(trustedIdentitySender({ ...state, currentWindow: false })).toBe(false);
  });
  it('captures the attempt before the dialog and rejects concurrent or renderer arguments', async () => {
    let finish!: (path: string | null) => void;
    const capture = new DatabaseIdentityCapture(42, 1);
    capture.consume(
      Buffer.from(
        `\x1eAIONCORE_DB_IDENTITY_V1 ${JSON.stringify({ v: 1, pid: 42, generation: '00112233-4455-4677-8899-aabbccddeeff', phase: 'bootstrap', ordinal: 0, status: 'unavailable', fingerprint: null, reason: 'unsupported_platform', sqliteCode: null, win32Code: null })}\n`
      ),
      () => {}
    );
    let snapshot = { ...capture.snapshot(), untrustedExtra: 'never-export' };
    const write = vi.fn().mockResolvedValue(undefined);
    const exportIdentity = createIdentityExporter({
      snapshot: () => snapshot,
      appVersion: () => 'test',
      choose: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      write,
    });
    expect(await exportIdentity(() => false, [])).toBe('failed');
    expect(await exportIdentity(() => true, ['injected'])).toBe('failed');
    const pending = exportIdentity(() => true, []);
    expect(await exportIdentity(() => true, [])).toBe('busy');
    snapshot = { ...new DatabaseIdentityCapture(42, 2).snapshot(), untrustedExtra: 'never-export' };
    finish('owned-test-target');
    expect(await pending).toBe('saved');
    expect(JSON.parse(write.mock.calls[0][1])).toMatchObject({ attemptOrdinal: 1, records: [{ ordinal: 0 }] });
    expect(write.mock.calls[0][1]).not.toContain('never-export');
  });
  it('does not write after cancellation or a stale sender', async () => {
    const write = vi.fn();
    const cancelled = createIdentityExporter({
      snapshot: () => new DatabaseIdentityCapture(42, 1).snapshot(),
      appVersion: () => 'test',
      choose: async () => null,
      write,
    });
    expect(await cancelled(() => true, [])).toBe('cancelled');
    let trusted = true;
    const stale = createIdentityExporter({
      snapshot: () => new DatabaseIdentityCapture(42, 1).snapshot(),
      appVersion: () => 'test',
      choose: async () => {
        trusted = false;
        return 'target';
      },
      write,
    });
    expect(await stale(() => trusted, [])).toBe('failed');
    expect(write).not.toHaveBeenCalled();
  });
  it('returns a closed failure when sender or snapshot access throws', async () => {
    const exportIdentity = createIdentityExporter({
      snapshot: () => {
        throw new Error('private error');
      },
      appVersion: () => 'test',
      choose: async () => null,
      write: async () => {},
    });
    expect(
      await exportIdentity(() => {
        throw new Error('private sender');
      }, [])
    ).toBe('failed');
    expect(await exportIdentity(() => true, [])).toBe('failed');
  });
});

describe('Thor local Core capability transport', () => {
  it('trusts a development document only on an explicit loopback HTTP origin', () => {
    expect(isTrustedDevDocument('http://127.0.0.1:5173/index.html')).toBe(true);
    expect(isTrustedDevDocument('http://localhost:5173/index.html')).toBe(true);
    expect(isTrustedDevDocument('https://example.org/index.html')).toBe(false);
    expect(isTrustedDevDocument('http://user@localhost:5173/index.html')).toBe(false);
    expect(isTrustedDevDocument('file:///tmp/index.html')).toBe(false);
  });
  const doc = 'file:///C:/thor/resources/app/renderer/index.html';
  const base = {
    url: 'http://127.0.0.1:13400/api/health',
    port: 13400,
    webContentsId: 7,
    expectedWebContentsId: 7,
    frameIsMain: true,
    frameUrl: doc + '#/chat',
    trustedDocuments: [doc],
  };
  it('only grants the trusted app top frame access to the exact Core endpoint', () => {
    expect(trustedCoreRequest(base)).toBe(true);
    expect(trustedCoreRequest({ ...base, url: 'ws://127.0.0.1:13400/ws' })).toBe(true);
    for (const bad of [
      { url: 'http://127.0.0.1:13401/api' },
      { url: 'http://localhost:13400/api' },
      { url: 'http://evil.example:13400/api' },
      { url: 'http://user@127.0.0.1:13400/api' },
      { webContentsId: 8 },
      { frameIsMain: false },
      { frameUrl: undefined },
      { frameUrl: 'file:///C:/other/index.html' },
      { port: undefined },
    ])
      expect(trustedCoreRequest({ ...base, ...bad })).toBe(false);
    expect(isCoreTarget('https://127.0.0.1:13400/api', 13400)).toBe(false);
  });
  it('strips an inherited or spoofed capability on untrusted destinations and redirect hops', () => {
    const incoming = { 'X-Thor-Local-Token': 'stale', Accept: 'application/json' };
    expect(coreRequestHeaders(incoming, { 'X-Thor-Local-Token': 'secret' }, false)).toEqual({
      Accept: 'application/json',
    });
    expect(coreRequestHeaders(incoming, { 'X-Thor-Local-Token': 'secret' }, true)).toEqual({
      Accept: 'application/json',
      'X-Thor-Local-Token': 'secret',
    });
  });
  it('normalizes only a single exact file origin for trusted Core WebSocket requests', () => {
    const auth = { 'X-Thor-Local-Token': 'secret' };
    const ws = 'ws://127.0.0.1:13400/ws';
    expect(coreRequestHeaders({ Origin: 'file://' }, auth, true, ws)).toEqual({ Origin: 'null', ...auth });
    expect(coreRequestHeaders({ oRiGiN: 'file://' }, auth, true, ws)).toEqual({ oRiGiN: 'null', ...auth });
    for (const origin of ['null', 'file:///other', 'file://other', 'http://localhost:5173', 'https://example.test']) {
      expect(coreRequestHeaders({ Origin: origin }, auth, true, ws)).toEqual({ Origin: origin, ...auth });
    }
    expect(coreRequestHeaders({ Origin: 'file://' }, auth, true, 'http://127.0.0.1:13400/api')).toEqual({
      Origin: 'file://',
      ...auth,
    });
    expect(coreRequestHeaders({ Origin: 'file://', 'X-Thor-Local-Token': 'spoofed' }, auth, false, ws)).toEqual({
      Origin: 'file://',
    });
    expect(coreRequestHeaders({ Origin: 'file://', origin: 'file://' }, auth, true, ws)).toEqual({
      Origin: 'file://',
      origin: 'file://',
      ...auth,
    });
    expect(coreRequestHeaders({}, auth, true, ws)).toEqual(auth);
  });
  it('authenticates only main-process fetches to the live port and refuses redirects', async () => {
    const original = vi.fn(async () => new Response('ok'));
    const host = { fetch: original as typeof fetch };
    let port = 13400;
    installCoreMainFetch(
      () => port,
      () => ({ 'X-Thor-Local-Token': 'secret' }),
      host
    );
    await host.fetch('http://127.0.0.1:13400/api', { headers: { Accept: 'text/plain' } });
    const opts = original.mock.calls[0][1] as RequestInit;
    expect(new Headers(opts.headers).get('X-Thor-Local-Token')).toBe('secret');
    expect(opts.redirect).toBe('error');
    expect(new Headers(opts.headers).get('Accept')).toBe('text/plain');
    port = 13401;
    await host.fetch('http://127.0.0.1:13400/api');
    expect(original.mock.calls[1][1]).toBeUndefined();
    await host.fetch('https://example.com');
    expect(original.mock.calls[2][1]).toBeUndefined();
  });
});
