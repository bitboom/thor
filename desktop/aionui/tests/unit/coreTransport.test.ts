import { describe, expect, it, vi } from 'vitest';
import {
  coreRequestHeaders,
  installCoreMainFetch,
  isCoreTarget,
  isTrustedDevDocument,
  trustedCoreRequest,
} from '@/process/startup/coreTransport';

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
