import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { connect } from 'node:net';
import WebSocket from 'ws';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => ({ isDestroyed: () => false, getType: () => 'window' })) },
}));
import { startCdpBridge, type CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';

function get(
  port: number,
  resource: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: resource, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
function connectWs(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    ws.on('error', reject);
  });
}

describe('browser CDP bridge local boundary', () => {
  let bridge: CdpBridgeHandle;
  beforeEach(async () => {
    bridge = await startCdpBridge();
  });
  afterEach(async () => {
    await bridge.close();
  });
  it('serves discovery to the canonical local native client but never returns tokens for rebinding or browser origins', async () => {
    const port = bridge.port;
    const authority = `127.0.0.1:${port}`;
    for (const endpoint of ['/json/version', '/json/list', '/json']) {
      const valid = await get(port, endpoint);
      expect(valid.status).toBe(200);
      expect(valid.body).toContain(bridge.token);
      for (const headers of [
        { Host: `evil.example:${port}` },
        { Host: `localhost:${port}` },
        { Host: `127.0.0.1:${port + 1}` },
        { Origin: 'null' },
        { Origin: 'https://evil.example' },
        { Origin: `http://127.0.0.1:${port + 1}` },
      ]) {
        const result = await get(port, endpoint, headers);
        expect(result.status).toBe(403);
        expect(result.body).not.toContain(bridge.token);
      }
    }
    expect((await get(port, '/json/version', { Origin: `http://${authority}` })).status).toBe(200);
    expect((await get(port, 'http://evil.example/json/version')).status).toBe(400);
  });
  it('rejects duplicate host and origin headers before discovery', async () => {
    const port = bridge.port;
    for (const extra of [`Host: evil.example:${port}`, 'Origin: null\r\nOrigin: http://evil.example']) {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(`GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\nConnection: close\r\n\r\n`)
        );
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString();
        });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 (400|403)/);
      expect(raw).not.toContain(bridge.token);
    }
  });
  it('requires the token and the same host/origin rules on WebSocket upgrades', async () => {
    const port = bridge.port;
    const ws = `ws://127.0.0.1:${port}/aionui-cdp?token=${bridge.token}`;
    expect(await connectWs(ws)).toBe(101);
    for (const headers of [
      { Host: `evil.example:${port}` },
      { Origin: 'null' },
      { Origin: 'https://evil.example' },
      { Origin: `http://127.0.0.1:${port + 1}` },
    ])
      expect(await connectWs(ws, headers)).toBe(403);
    expect(await connectWs(`ws://127.0.0.1:${port}/aionui-cdp?token=wrong`)).toBe(403);
  });
  it('never attaches the main window as a CDP target', () => {
    expect(bridge.attach(1)).toMatchObject({ ok: false });
    expect(bridge.attachedWebContentsId()).toBeNull();
  });
});
