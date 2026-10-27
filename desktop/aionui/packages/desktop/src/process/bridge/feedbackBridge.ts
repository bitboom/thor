/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC handler for collecting and compressing recent log files
 * for the bug report feature.
 */

import { ipcMain, app, BrowserWindow, net, shell } from 'electron';
import * as path from 'path';
import { existsSync } from 'node:fs';
import { collectFeedbackLogAttachment } from '../feedback/logs';

type RendererFeedbackLogPayload = {
  details?: unknown;
  level?: unknown;
  message?: unknown;
};

function normalizeRendererFeedbackLogPayload(payload: RendererFeedbackLogPayload): {
  details?: unknown;
  level: 'info' | 'warn' | 'error';
  message: string;
} {
  const level = payload.level === 'warn' || payload.level === 'error' ? payload.level : 'info';
  const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : 'feedback log';
  return {
    level,
    message,
    details: payload.details,
  };
}

ipcMain.on('feedback:renderer-log', (_event, payload: RendererFeedbackLogPayload) => {
  const log = normalizeRendererFeedbackLogPayload(payload ?? {});
  const args = [`[FeedbackReport:renderer] ${log.message}`];
  if (log.details !== undefined) {
    args.push(log.details as string);
  }

  if (log.level === 'error') {
    console.error(...args);
  } else if (log.level === 'warn') {
    console.warn(...args);
  } else {
    console.info(...args);
  }
});

ipcMain.handle('feedback:collect-logs', async () => {
  try {
    let logsDir: string;
    try {
      logsDir = app.getPath('logs');
    } catch {
      logsDir = path.join(app.getPath('userData'), 'logs');
    }

    const logDirs = [logsDir, path.join(logsDir, 'logs')];
    const attachment = collectFeedbackLogAttachment(logDirs);
    if (!attachment) return null;

    // Return as number array for IPC serialization (Buffer is not serializable)
    return {
      filename: attachment.filename,
      data: Array.from(attachment.data),
    };
  } catch (error) {
    console.error('[feedbackBridge] Failed to collect logs:', error);
    return null;
  }
});

ipcMain.handle('feedback:capture-screenshot', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return null;
    }

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    if (!png || png.length === 0) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      filename: `screenshot-${timestamp}.png`,
      data: Array.from(png),
    };
  } catch (error) {
    console.error('[feedbackBridge] Failed to capture screenshot:', error);
    return null;
  }
});

/** Thor feedback is submitted through the user's existing GitHub CLI authentication. */
import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { prepareThorFeedback, type ThorFeedbackPayload } from '@/common/types/feedbackDiagnostics';

function thorGhExecutable(): string {
  if (!app.isPackaged) return 'gh';
  const bundled = path.join(
    process.resourcesPath,
    'thor-release',
    'tools',
    process.platform === 'win32' ? 'gh.exe' : 'gh'
  );
  return existsSync(bundled) ? bundled : 'gh';
}
function thorGhStatus(): Promise<{ status: 'authenticated' | 'unauthenticated' | 'missing'; executable: string }> {
  const executable = thorGhExecutable();
  return new Promise((resolve) => {
    const child = spawn(executable, ['auth', 'status', '--hostname', 'github.com'], {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      },
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (status: 'authenticated' | 'unauthenticated' | 'missing') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, executable });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish('unauthenticated');
    }, 10000);
    child.on('error', () => finish('missing'));
    child.on('close', (code) => finish(code === 0 ? 'authenticated' : 'unauthenticated'));
  });
}

export function submitThorIssue(payload: ThorFeedbackPayload): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(thorGhExecutable(), ['api', '--method', 'POST', 'repos/bitboom/thor/issues', '--input', '-'], {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let done = false;
    const finish = (error?: Error, url?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error || !url) reject(error ?? new Error('Feedback submission failed.'));
      else resolve({ url });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Submission timed out. Check GitHub for an issue before retrying.'));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 100000) {
        child.kill();
        finish(new Error('Unexpected GitHub response.'));
      }
    });
    child.on('error', () => finish(new Error('GitHub CLI could not start. Install and authenticate gh, then retry.')));
    child.on('close', (code) => {
      if (code !== 0)
        return finish(new Error('GitHub submission failed. Check gh authentication and repository access.'));
      try {
        const url: unknown = JSON.parse(output).html_url;
        if (typeof url !== 'string' || !/^https:\/\/github\.com\/bitboom\/thor\/issues\/\d+$/.test(url))
          throw new Error();
        finish(undefined, url);
      } catch {
        finish(new Error('Unexpected GitHub response. Check the issue tracker before retrying.'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const pendingFeedbackPath = () => path.join(app.getPath('userData'), 'thor-feedback-pending.json');
let journalBusy = false;
async function withFeedbackJournal<T>(operation: () => Promise<T>): Promise<T> {
  // Acquire synchronously before any asynchronous journal read or write. Reject
  // overlapping actions rather than queueing stale user acknowledgements.
  if (journalBusy) throw new Error('Feedback report is still being processed.');
  journalBusy = true;
  try {
    return await operation();
  } finally {
    journalBusy = false;
  }
}
const validReportId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
type FeedbackRecord = {
  reportId: string;
  draft: ThorFeedbackPayload | null;
  state: 'pending' | 'submitted';
  url?: string;
};
async function readPendingFeedback(): Promise<FeedbackRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(pendingFeedbackPath(), 'utf8'));
    if (typeof value === 'string' && validReportId(value)) return { reportId: value, draft: null, state: 'pending' };
    if (value && typeof value === 'object') {
      const record = value as FeedbackRecord;
      if (
        typeof record.reportId === 'string' &&
        validReportId(record.reportId) &&
        (record.state === 'pending' ||
          (record.state === 'submitted' &&
            typeof record.url === 'string' &&
            /^https:\/\/github\.com\/bitboom\/thor\/issues\/\d+$/.test(record.url)))
      ) {
        if (record.draft !== null && checkedFeedback(record.draft).reportId !== record.reportId)
          throw new Error('Invalid journal identity');
        return record;
      }
    }
    throw new Error('Invalid journal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { reportId: 'unknown', draft: null, state: 'pending' };
  }
}
async function persistOutcome(record: FeedbackRecord, url: string): Promise<void> {
  const temp = pendingFeedbackPath() + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ ...record, state: 'submitted', url }), { flag: 'wx', mode: 0o600 });
    await rename(temp, pendingFeedbackPath());
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function assertThorSender(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame || !app.isReady())
    throw new Error('Invalid sender.');
}
ipcMain.handle('thor:feedback-auth-status', async (event) => {
  assertThorSender(event);
  return thorGhStatus();
});
ipcMain.handle('thor:feedback-pending', async (event) => {
  assertThorSender(event);
  return withFeedbackJournal(readPendingFeedback);
});
ipcMain.handle('thor:feedback-resolve', async (event, reportId: unknown) => {
  assertThorSender(event);
  return withFeedbackJournal(async () => {
    if (typeof reportId !== 'string' || (await readPendingFeedback())?.reportId !== reportId)
      throw new Error('Pending report changed.');
    await unlink(pendingFeedbackPath());
  });
});
function checkedFeedback(payload: unknown): { prepared: ThorFeedbackPayload; reportId: string } {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid feedback.');
  const candidate = payload as Partial<ThorFeedbackPayload>;
  if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') throw new Error('Invalid feedback.');
  const prepared = prepareThorFeedback(candidate.title, candidate.body);
  const reportId = prepared.body.match(/\n\nThor report ID: ([0-9a-f-]+)$/i)?.[1];
  if (
    !prepared.title ||
    !reportId ||
    !validReportId(reportId) ||
    prepared.title !== candidate.title ||
    prepared.body !== candidate.body
  )
    throw new Error('Review the sanitized feedback before submitting.');
  return { prepared, reportId };
}
async function reserveFeedback(reportId: string, draft: ThorFeedbackPayload): Promise<FeedbackRecord> {
  // Reserve before network or browser activity; unresolved work survives restart.
  const record: FeedbackRecord = { reportId, draft, state: 'pending' };
  await writeFile(pendingFeedbackPath(), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
ipcMain.handle('thor:submit-feedback', async (event, payload: unknown) => {
  assertThorSender(event);
  return withFeedbackJournal(async () => {
    const { prepared, reportId } = checkedFeedback(payload);
    const record = await reserveFeedback(reportId, prepared);
    const result = await submitThorIssue(prepared);
    await persistOutcome(record, result.url);
    return result;
  });
});
ipcMain.handle('thor:feedback-open-browser', async (event, payload: unknown) => {
  assertThorSender(event);
  return withFeedbackJournal(async () => {
    const { prepared, reportId } = checkedFeedback(payload);
    const query = new URLSearchParams(prepared).toString();
    if (query.length > 6000) throw new Error('Issue draft is too long for browser submission.');
    await reserveFeedback(reportId, prepared);
    await shell.openExternal('https://github.com/bitboom/thor/issues/new?' + query);
  });
});
ipcMain.handle('thor:feedback-verify', async (event, reportId: unknown) => {
  assertThorSender(event);
  return withFeedbackJournal(async () => {
    if (
      typeof reportId !== 'string' ||
      !validReportId(reportId) ||
      (await readPendingFeedback())?.reportId !== reportId
    )
      throw new Error('Pending report changed.');
    const response = await net.fetch(
      'https://api.github.com/repos/bitboom/thor/issues?state=all&sort=created&direction=desc&per_page=100',
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) }
    );
    if (!response.ok) throw new Error('GitHub verification unavailable.');
    const issues: unknown = await response.json();
    if (!Array.isArray(issues)) throw new Error('Unexpected GitHub response.');
    const marker = '\n\nThor report ID: ' + reportId;
    const found = issues.find((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const issue = item as { body?: unknown; html_url?: unknown; pull_request?: unknown };
      return (
        !issue.pull_request &&
        typeof issue.body === 'string' &&
        issue.body.replace(/\r\n/g, '\n').trimEnd().endsWith(marker) &&
        typeof issue.html_url === 'string' &&
        /^https:\/\/github\.com\/bitboom\/thor\/issues\/\d+$/.test(issue.html_url)
      );
    }) as { html_url: string } | undefined;
    if (!found) return null;
    const record = await readPendingFeedback();
    if (!record || record.reportId !== reportId) throw new Error('Pending report changed.');
    await persistOutcome(record, found.html_url);
    return { url: found.html_url };
  });
});

ipcMain.handle('thor:synthetic-mail-config', (event) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame)
    throw new Error('Invalid sender.');
  return {
    command: process.execPath,
    script: app.isPackaged
      ? path.join(process.resourcesPath, 'thor', 'synthetic-mail', 'server.mjs')
      : path.resolve(app.getAppPath(), '..', '..', 'integrations', 'synthetic-mail', 'server.mjs'),
  };
});
