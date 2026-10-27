/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Node-environment tests for feedbackBridge's IPC handlers.
 * Covers the new feedback:capture-screenshot handler (main-process side).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { app, net, shell } from 'electron';
import { collectFeedbackLogAttachment } from '@/process/feedback/logs';
import { prepareThorFeedback } from '@/common/types/feedbackDiagnostics';

// Table of handlers registered via ipcMain.handle during module import.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

type FakeWebContents = {
  capturePage?: () => Promise<{ toPNG: () => Buffer }>;
};

type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: FakeWebContents;
};

let currentWindow: FakeWindow | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
  },
  app: {
    getPath: vi.fn(() => '/tmp/aionui-test-logs-nonexistent'),
    getVersion: vi.fn(() => '0.0.0'),
    isReady: vi.fn(() => true),
  },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => currentWindow),
  },
}));

beforeEach(async () => {
  handlers.clear();
  currentWindow = null;
  vi.resetModules();
  // Importing registers the ipcMain.handle callbacks into our map.
  await import('@/process/bridge/feedbackBridge');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('feedbackBridge — capture-screenshot', () => {
  it('registers the feedback:capture-screenshot channel on import', () => {
    expect(handlers.has('feedback:capture-screenshot')).toBe(true);
  });

  it('returns png bytes and a timestamped filename on success', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => ({ toPNG: () => pngBytes })),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = (await handler({ sender: {} })) as { filename: string; data: number[] } | null;

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^screenshot-.*\.png$/);
    expect(result!.data).toEqual(Array.from(pngBytes));
  });

  it('returns null when no owning BrowserWindow is resolved', async () => {
    currentWindow = null;
    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
  });

  it('returns null when the owning BrowserWindow is destroyed', async () => {
    currentWindow = {
      isDestroyed: () => true,
      webContents: {
        capturePage: vi.fn(),
      },
    };
    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
    expect(currentWindow.webContents.capturePage).not.toHaveBeenCalled();
  });

  it('returns null when capturePage yields an empty buffer', async () => {
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(0) })),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
  });

  it('returns null and does not throw when capturePage rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => {
          throw new Error('capture refused');
        }),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('Thor reviewed path redaction', () => {
  it('rejects an unreviewed network path and accepts only its sanitized draft', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-path-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    const raw = {
      title: 'file://CANARY_HOST/share',
      body: '\\\\CANARY_SERVER\\share\\report.docx\n\nThor report ID: ' + id,
    };
    const draft = prepareThorFeedback(raw.title, raw.body);
    vi.mocked(app.getPath).mockReturnValue(dir);
    vi.mocked(shell.openExternal).mockResolvedValue();
    currentWindow = { isDestroyed: () => false, webContents: {} };
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    try {
      const open = handlers.get('thor:feedback-open-browser')!;
      await expect(open(event, raw)).rejects.toThrow('Review the sanitized feedback');
      await open(event, draft);
      const url = new URL(vi.mocked(shell.openExternal).mock.calls.at(-1)![0]);
      expect(url.searchParams.get('title')).toBe(draft.title);
      expect(url.searchParams.get('body')).toBe(draft.body);
      expect(url.toString()).not.toMatch(/CANARY_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('feedback logs', () => {
  it('collects top-level frontend logs and nested backend logs through the IPC handler', async () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-bridge-'));
    try {
      const backendLogsDir = path.join(logsDir, 'logs');
      mkdirSync(backendLogsDir);
      writeFileSync(path.join(logsDir, '2026-05-25.log'), 'frontend renderer log\n');
      writeFileSync(path.join(backendLogsDir, '2026-05-25.log'), 'backend process log\n');
      writeFileSync(path.join(backendLogsDir, '2026-05-24.log'), 'second day backend log\n');
      writeFileSync(path.join(backendLogsDir, '2026-05-23.log'), 'third day backend log\n');
      writeFileSync(path.join(backendLogsDir, '2026-05-22.log'), 'too old backend log\n');

      vi.mocked(app.getPath).mockImplementation((name: string) => {
        if (name === 'logs') return logsDir;
        return path.join(logsDir, 'userData');
      });

      const handler = handlers.get('feedback:collect-logs')!;
      const result = (await handler({})) as { filename: string; data: number[] } | null;

      expect(result).not.toBeNull();
      const content = gunzipSync(Buffer.from(result!.data)).toString('utf8');
      expect(content).toContain('frontend renderer log');
      expect(content).toContain('backend process log');
      expect(content).toContain('second day backend log');
      expect(content).toContain('third day backend log');
      expect(content).not.toContain('too old backend log');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('collects the same recent three log days used by user feedback reports', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-logs-'));
    try {
      writeFileSync(path.join(logsDir, '2026-05-25.log'), 'today frontend\n');
      writeFileSync(path.join(logsDir, '2026-05-25.aioncore.log'), 'today backend\n');
      writeFileSync(path.join(logsDir, '2026-05-24.aionrs.log'), 'yesterday rust\n');
      writeFileSync(path.join(logsDir, '2026-05-23.log'), 'third day frontend\n');
      writeFileSync(path.join(logsDir, '2026-05-22.log'), 'too old frontend\n');
      writeFileSync(path.join(logsDir, '2026-05-25.txt'), 'not a log\n');

      const attachment = collectFeedbackLogAttachment(logsDir);

      expect(attachment).not.toBeNull();
      expect(attachment!.filename).toBe('logs.gz');
      expect(attachment!.contentType).toBe('application/gzip');
      const content = gunzipSync(attachment!.data).toString('utf8');
      expect(content).toContain('today frontend');
      expect(content).toContain('today backend');
      expect(content).toContain('yesterday rust');
      expect(content).toContain('third day frontend');
      expect(content).not.toContain('too old frontend');
      expect(content).not.toContain('not a log');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('collects recent logs from dated year/month/day directories', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-dated-logs-'));
    try {
      const recentDir = path.join(logsDir, '2026', '07', '02');
      const previousDir = path.join(logsDir, '2026', '07', '01');
      const oldDir = path.join(logsDir, '2026', '06', '30');
      mkdirSync(recentDir, { recursive: true });
      mkdirSync(previousDir, { recursive: true });
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(recentDir, '2026-07-02.log'), 'today frontend nested\n');
      writeFileSync(path.join(recentDir, '2026-07-02.aioncore.log'), 'today backend nested\n');
      writeFileSync(path.join(previousDir, '2026-07-01.aionrs.log'), 'yesterday rust nested\n');
      writeFileSync(path.join(oldDir, '2026-06-30.log'), 'third day frontend nested\n');
      writeFileSync(path.join(logsDir, '2026-06-29.log'), 'too old flat\n');

      const attachment = collectFeedbackLogAttachment(logsDir);

      expect(attachment).not.toBeNull();
      const content = gunzipSync(attachment!.data).toString('utf8');
      expect(content).toContain('today frontend nested');
      expect(content).toContain('today backend nested');
      expect(content).toContain('yesterday rust nested');
      expect(content).toContain('third day frontend nested');
      expect(content).not.toContain('too old flat');
      expect(content).toContain('2026/07/02/2026-07-02.aioncore.log');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('Thor feedback pending state', () => {
  it('rejects overlapping submit, resolve, browser and verify until the outcome is durable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-concurrent-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    const payload = { title: 'Test', body: 'Reviewed\n\nThor report ID: ' + id };
    vi.mocked(app.getPath).mockReturnValue(dir);
    currentWindow = { isDestroyed: () => false, webContents: {} };
    let child!: ReturnType<typeof spawn>;
    let stdout!: PassThrough;
    vi.mocked(spawn).mockImplementation(() => {
      child = new EventEmitter() as ReturnType<typeof spawn>;
      stdout = new PassThrough();
      Object.assign(child, { stdin: new PassThrough(), stdout, kill: vi.fn() });
      return child;
    });
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    const submit = handlers.get('thor:submit-feedback')!;
    try {
      const first = submit(event, payload);
      await expect(submit(event, payload)).rejects.toThrow('still being processed');
      await expect(handlers.get('thor:feedback-resolve')!(event, id)).rejects.toThrow('still being processed');
      await expect(handlers.get('thor:feedback-open-browser')!(event, payload)).rejects.toThrow(
        'still being processed'
      );
      await expect(handlers.get('thor:feedback-verify')!(event, id)).rejects.toThrow('still being processed');
      await vi.waitFor(() => expect(child).toBeDefined());
      stdout.write(JSON.stringify({ html_url: 'https://github.com/bitboom/thor/issues/42' }));
      child.emit('close', 0);
      await first;
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: id,
        draft: payload,
        state: 'submitted',
        url: 'https://github.com/bitboom/thor/issues/42',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not allow an old concurrent resolve to delete a newly reserved report', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-resolve-race-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    const nextId = '22345678-1234-4234-8234-123456789abc';
    const payload = { title: 'Test', body: 'Reviewed\n\nThor report ID: ' + id };
    const next = { title: 'Next', body: 'Reviewed\n\nThor report ID: ' + nextId };
    vi.mocked(app.getPath).mockReturnValue(dir);
    vi.mocked(shell.openExternal).mockResolvedValue();
    currentWindow = { isDestroyed: () => false, webContents: {} };
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    try {
      await handlers.get('thor:feedback-open-browser')!(event, payload);
      const first = handlers.get('thor:feedback-resolve')!(event, id);
      await expect(handlers.get('thor:feedback-resolve')!(event, id)).rejects.toThrow('still being processed');
      await expect(handlers.get('thor:feedback-open-browser')!(event, next)).rejects.toThrow('still being processed');
      await first;
      await handlers.get('thor:feedback-open-browser')!(event, next);
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: nextId,
        draft: next,
        state: 'pending',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('persists the submitted outcome before returning, so a lost IPC reply is recoverable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-success-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    const payload = { title: 'Test', body: 'Reviewed\n\nThor report ID: ' + id };
    vi.mocked(app.getPath).mockReturnValue(dir);
    currentWindow = { isDestroyed: () => false, webContents: {} };
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      const stdout = new PassThrough();
      Object.assign(child, { stdin: new PassThrough(), stdout, kill: vi.fn() });
      queueMicrotask(() => {
        stdout.write(JSON.stringify({ html_url: 'https://github.com/bitboom/thor/issues/42' }));
        child.emit('close', 0);
      });
      return child;
    });
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    try {
      await handlers.get('thor:submit-feedback')!(event, payload);
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: id,
        draft: payload,
        state: 'submitted',
        url: 'https://github.com/bitboom/thor/issues/42',
      });
      await expect(handlers.get('thor:submit-feedback')!(event, payload)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('persists an uncertain report and blocks duplicate submission until acknowledged', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-test-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    vi.mocked(app.getPath).mockReturnValue(dir);
    currentWindow = { isDestroyed: () => false, webContents: {} };
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => child.emit('error', new Error('unavailable')));
      return child;
    });
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    const payload = { title: 'Test', body: 'Description\n\nThor report ID: ' + id };
    const submit = handlers.get('thor:submit-feedback')!;
    try {
      await expect(submit(event, payload)).rejects.toThrow();
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: id,
        draft: payload,
        state: 'pending',
      });
      await expect(submit(event, payload)).rejects.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1);
      await handlers.get('thor:feedback-resolve')!(event, id);
      expect(await handlers.get('thor:feedback-pending')!(event)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Thor browser feedback fallback', () => {
  it('does not verify an old report that has no reviewed draft', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-legacy-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    vi.mocked(app.getPath).mockReturnValue(dir);
    currentWindow = { isDestroyed: () => false, webContents: {} };
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    try {
      writeFileSync(path.join(dir, 'thor-feedback-pending.json'), JSON.stringify(id));
      expect(await handlers.get('thor:feedback-verify')!(event, id)).toBeNull();
      expect(net.fetch).not.toHaveBeenCalled();
      expect(await handlers.get('thor:feedback-pending')!(event)).toMatchObject({
        reportId: id,
        draft: null,
        state: 'pending',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('opens only the reviewed draft and verifies the matching public issue before clearing pending state', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'thor-feedback-browser-'));
    const id = '12345678-1234-4234-8234-123456789abc';
    vi.mocked(app.getPath).mockReturnValue(dir);
    currentWindow = { isDestroyed: () => false, webContents: {} };
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    const payload = { title: 'Test title', body: 'Reviewed text\n\nThor report ID: ' + id };
    vi.mocked(shell.openExternal).mockResolvedValue();
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);
    try {
      await handlers.get('thor:feedback-open-browser')!(event, payload);
      const url = new URL(vi.mocked(shell.openExternal).mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe('https://github.com/bitboom/thor/issues/new');
      expect(url.searchParams.get('title')).toBe(payload.title);
      expect(url.searchParams.get('body')).toBe(payload.body);
      expect(await handlers.get('thor:feedback-verify')!(event, id)).toBeNull();
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: id,
        draft: payload,
        state: 'pending',
      });
      vi.mocked(net.fetch).mockResolvedValue({
        ok: true,
        json: async () => [
          { title: 'Altered title', body: payload.body, html_url: 'https://github.com/bitboom/thor/issues/40' },
          {
            title: payload.title,
            body: 'Altered text\n\nThor report ID: ' + id,
            html_url: 'https://github.com/bitboom/thor/issues/41',
          },
        ],
      } as unknown as Response);
      expect(await handlers.get('thor:feedback-verify')!(event, id)).toBeNull();
      expect(await handlers.get('thor:feedback-pending')!(event)).toMatchObject({ reportId: id, state: 'pending' });
      vi.mocked(net.fetch).mockResolvedValue({
        ok: true,
        json: async () => [
          {
            title: payload.title,
            body: payload.body.replace(/\n/g, '\r\n'),
            html_url: 'https://github.com/bitboom/thor/issues/42',
          },
        ],
      } as unknown as Response);
      expect(await handlers.get('thor:feedback-verify')!(event, id)).toEqual({
        url: 'https://github.com/bitboom/thor/issues/42',
      });
      expect(await handlers.get('thor:feedback-pending')!(event)).toEqual({
        reportId: id,
        draft: payload,
        state: 'submitted',
        url: 'https://github.com/bitboom/thor/issues/42',
      });
      await expect(handlers.get('thor:feedback-open-browser')!(event, payload)).rejects.toThrow();
      await handlers.get('thor:feedback-resolve')!(event, id);
      expect(await handlers.get('thor:feedback-pending')!(event)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
