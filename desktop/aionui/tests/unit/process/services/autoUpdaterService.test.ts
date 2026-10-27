/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { rmSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoUpdaterMock = vi.hoisted(() => ({
  logger: null as unknown,
  autoDownload: true,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  allowPrerelease: false,
  allowDowngrade: false,
  channel: undefined as string | undefined,
  currentVersion: { version: '2.1.13' },
  setFeedURL: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getOrCreateDownloadHelper: vi.fn(),
  quitAndInstall: vi.fn(),
  install: vi.fn(),
  quitAndInstallCalled: false,
  autoRunAppAfterInstall: true,
  checkForUpdatesAndNotify: vi.fn(),
}));

const nativeAutoUpdaterMock = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  emit: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  isPackaged: false,
  getVersion: vi.fn(() => '2.1.13'),
  getPath: vi.fn(() => '/tmp/aionui-test'),
  exit: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock,
}));

vi.mock('electron', () => ({
  app: appMock,
  autoUpdater: nativeAutoUpdaterMock,
}));

vi.mock('@/process/services/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
  i18nReady: Promise.resolve(),
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
};

describe('AutoUpdaterService', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform(originalPlatform);
    autoUpdaterMock.logger = null;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.forceDevUpdateConfig = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.channel = undefined;
    autoUpdaterMock.quitAndInstallCalled = false;
    autoUpdaterMock.autoRunAppAfterInstall = true;
    autoUpdaterMock.install.mockReset().mockReturnValue(true);
    appMock.getPath.mockImplementation(() => '/tmp/aionui-test');
    delete (autoUpdaterMock as { updateInfoAndProvider?: unknown }).updateInfoAndProvider;
    appMock.isPackaged = false;
    delete process.env.AIONUI_FORCE_DEV_AUTO_UPDATE;
    delete process.env.AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION;
    nativeAutoUpdaterMock.on.mockReset();
    nativeAutoUpdaterMock.removeListener.mockReset();
    autoUpdaterMock.quitAndInstall.mockReset();
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      const handler = nativeAutoUpdaterMock.on.mock.calls.findLast((call) => call[0] === 'before-quit-for-update')?.[1];
      handler?.();
    });
    Object.defineProperty(autoUpdaterMock, 'currentVersion', {
      configurable: true,
      value: { version: '2.1.13' },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  it('fails closed when the Core guard is missing or reports active work', async () => {
    setPlatform('win32');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unavailable' });
    autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: false, reason: 'active' }));
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'active' });
    expect(autoUpdaterMock.install).not.toHaveBeenCalled();
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
  });

  it('retains the reservation when installer handoff outcome is unknown', async () => {
    setPlatform('darwin');
    vi.useFakeTimers();
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    const rollback = vi.fn(async () => {});
    autoUpdaterService.initialize();
    getUpdateDownloadedHandler()({ version: '2.2.0' });
    getNativeUpdateDownloadedHandler()();
    autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: true, rollback }));
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {});
    const result = autoUpdaterService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toEqual({ status: 'deferred', reason: 'unknown' });
    expect(rollback).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it('allows only one concurrent installation attempt while reservation is pending', async () => {
    setPlatform('win32');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    let finish!: (result: { ok: true; rollback: () => Promise<void> }) => void;
    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = autoUpdaterService.quitAndInstall();
    await Promise.resolve();
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'active' });
    finish({ ok: true, rollback: async () => {} });
    await expect(first).resolves.toEqual({ status: 'started' });
    expect(autoUpdaterMock.install).toHaveBeenCalledTimes(1);
  });

  it('releases the Core reservation when updater reports no handoff started', async () => {
    setPlatform('win32');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    const rollback = vi.fn(async () => {});
    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: true, rollback }));
    autoUpdaterMock.install.mockReturnValue(false);
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unavailable' });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it('retains the reservation when a Windows installer call throws or was already in progress', async () => {
    setPlatform('win32');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    const rollback = vi.fn(async () => {});
    autoUpdaterService.initialize();
    const preflight = vi.fn(async () => ({ ok: true as const, rollback }));
    autoUpdaterService.setBeforeQuitAndInstall(preflight);
    autoUpdaterMock.install.mockImplementationOnce(() => {
      throw new Error('synthetic ambiguous error');
    });
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unknown' });
    autoUpdaterMock.quitAndInstallCalled = true;
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unknown' });
    expect(autoUpdaterMock.install).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it('does not release when electron-updater already has a handoff in progress', async () => {
    setPlatform('win32');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    const rollback = vi.fn(async () => {});
    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: true, rollback }));
    autoUpdaterMock.quitAndInstallCalled = true;
    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unknown' });
    expect(autoUpdaterMock.install).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not use the stable CDN updater when prerelease manual mode is enabled', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '2.1.14',
        files: [{ url: 'AionUi-2.1.14-mac-arm64.dmg', sha512: 'sha512-value' }],
        path: 'AionUi-2.1.14-mac-arm64.dmg',
        sha512: 'sha512-value',
        releaseDate: '2026-06-08T00:00:00.000Z',
      },
    });

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setAllowPrerelease(true);

    const result = await autoUpdaterService.checkForUpdates();

    expect(result).toEqual({ success: true });
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it('ignores a feed version that is not newer than the installed build', async () => {
    appMock.getVersion.mockReturnValue('2.1.54');
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '2.1.53',
        files: [{ url: 'AionUi-2.1.53-mac-arm64.dmg', sha512: 'sha512-value' }],
        path: 'AionUi-2.1.53-mac-arm64.dmg',
        sha512: 'sha512-value',
        releaseDate: '2026-06-08T00:00:00.000Z',
      },
    });

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const result = await autoUpdaterService.checkForUpdates();

    expect(result).toEqual({ success: true });
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports a feed version that is strictly newer than the installed build', async () => {
    appMock.getVersion.mockReturnValue('2.1.13');
    const updateInfo = {
      version: '2.1.14',
      files: [{ url: 'AionUi-2.1.14-mac-arm64.dmg', sha512: 'sha512-value' }],
      path: 'AionUi-2.1.14-mac-arm64.dmg',
      sha512: 'sha512-value',
      releaseDate: '2026-06-08T00:00:00.000Z',
    };
    autoUpdaterMock.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo });

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const result = await autoUpdaterService.checkForUpdates();

    expect(result).toEqual({ success: true, updateInfo });
  });

  it('configures electron-updater to read stable releases from Thor on GitHub', async () => {
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.resetForTest();

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'bitboom',
      repo: 'thor',
      private: false,
      releaseType: 'release',
    });
  });

  it('enables forced updater checks in unpacked dev builds when requested', async () => {
    process.env.AIONUI_FORCE_DEV_AUTO_UPDATE = '1';

    await import('@/process/services/autoUpdaterService');

    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(true);
  });

  it('overrides the updater current version only for forced unpacked dev checks', async () => {
    process.env.AIONUI_FORCE_DEV_AUTO_UPDATE = '1';
    process.env.AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION = '2.1.12';

    await import('@/process/services/autoUpdaterService');

    expect(autoUpdaterMock.currentVersion.version).toBe('2.1.12');
  });

  it('ignores forced updater debug env in packaged builds', async () => {
    appMock.isPackaged = true;
    process.env.AIONUI_FORCE_DEV_AUTO_UPDATE = '1';
    process.env.AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION = '2.1.12';

    await import('@/process/services/autoUpdaterService');

    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(false);
    expect(autoUpdaterMock.currentVersion.version).toBe('2.1.13');
  });

  const getErrorHandler = (): ((error: Error) => void) => {
    const entry = autoUpdaterMock.on.mock.calls.find(([event]) => event === 'error');
    if (!entry) throw new Error('error handler not registered');
    return entry[1] as (error: Error) => void;
  };

  const getUpdateDownloadedHandler = (): ((info: { version: string }) => void) => {
    const entry = autoUpdaterMock.on.mock.calls.find(([event]) => event === 'update-downloaded');
    if (!entry) throw new Error('update-downloaded handler not registered');
    return entry[1] as (info: { version: string }) => void;
  };

  const getNativeUpdateDownloadedHandler = (): (() => void) => {
    const entry = nativeAutoUpdaterMock.on.mock.calls.find(([event]) => event === 'update-downloaded');
    if (!entry) throw new Error('native update-downloaded handler not registered');
    return entry[1] as () => void;
  };

  const getNativeErrorHandler = (): ((error: Error) => void) => {
    const entry = nativeAutoUpdaterMock.on.mock.calls.find(([event]) => event === 'error');
    if (!entry) throw new Error('native error handler not registered');
    return entry[1] as (error: Error) => void;
  };

  const getCheckingForUpdateHandler = (): (() => void) => {
    const entry = autoUpdaterMock.on.mock.calls.find(([event]) => event === 'checking-for-update');
    if (!entry) throw new Error('checking-for-update handler not registered');
    return entry[1] as () => void;
  };

  it('clarifies the Squirrel bundle error in dev mode', async () => {
    appMock.isPackaged = false;
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const statuses: Array<{ status: string; error?: string }> = [];
    autoUpdaterService.on('update-status', (s: { status: string; error?: string }) => statuses.push(s));

    getErrorHandler()(new Error('Could not locate update bundle for com.github.Electron within file:///tmp/x'));

    const errorStatus = statuses.find((s) => s.status === 'error');
    expect(errorStatus?.error).toContain('[dev]');
    expect(errorStatus?.error).toContain('Could not locate update bundle');
  });

  it('passes through unrelated auto-updater errors verbatim', async () => {
    appMock.isPackaged = false;
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const statuses: Array<{ status: string; error?: string }> = [];
    autoUpdaterService.on('update-status', (s: { status: string; error?: string }) => statuses.push(s));

    getErrorHandler()(new Error('network timeout'));

    const errorStatus = statuses.find((s) => s.status === 'error');
    expect(errorStatus?.error).toBe('network timeout');
  });

  it('reuses the active auto-update download promise', async () => {
    let resolveDownload!: () => void;
    autoUpdaterMock.downloadUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        })
    );

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const first = autoUpdaterService.downloadUpdate();
    const second = autoUpdaterService.downloadUpdate();

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);

    resolveDownload();
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
  });

  it('allows a new auto-update download after a terminal updater event', async () => {
    autoUpdaterMock.downloadUpdate.mockResolvedValue(undefined);

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    await expect(autoUpdaterService.downloadUpdate()).resolves.toEqual({ success: true });
    getUpdateDownloadedHandler()({ version: '2.2.0' });
    await expect(autoUpdaterService.downloadUpdate()).resolves.toEqual({ success: true });

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('passes a cancellation token to auto-updater and cancels it on cancelDownload', async () => {
    let resolveDownload!: () => void;
    autoUpdaterMock.downloadUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        })
    );

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    const download = autoUpdaterService.downloadUpdate();

    const token = autoUpdaterMock.downloadUpdate.mock.calls[0]?.[0] as
      | { cancel: () => void; cancelled: boolean }
      | undefined;
    expect(token).toBeTruthy();
    expect(token?.cancelled).toBe(false);

    await expect(autoUpdaterService.cancelDownload()).resolves.toEqual({ success: true });

    expect(token?.cancelled).toBe(true);

    resolveDownload();
    await expect(download).resolves.toEqual({ success: true });
  });

  it('restores a completed cached auto-update when the downloaded package validates', async () => {
    const updateInfo = {
      version: '2.1.14',
      files: [{ url: 'AionUi-2.1.14-mac.zip', sha512: 'sha512-value' }],
      path: 'AionUi-2.1.14-mac.zip',
      sha512: 'sha512-value',
      releaseDate: '2026-06-08T00:00:00.000Z',
    };
    const fileInfo = {
      url: new URL('https://static.aionui.com/releases/2.1.14/AionUi-2.1.14-mac.zip'),
      info: { url: 'AionUi-2.1.14-mac.zip', sha512: 'sha512-value' },
    };
    const cachedUpdatePath = path.join('/cache/pending', 'AionUi-2.1.14-mac.zip');
    const validateDownloadedPath = vi.fn().mockResolvedValue(cachedUpdatePath);

    autoUpdaterMock.checkForUpdates.mockImplementation(async () => {
      (autoUpdaterMock as { updateInfoAndProvider?: unknown }).updateInfoAndProvider = {
        info: updateInfo,
        provider: { resolveFiles: vi.fn(() => [fileInfo]) },
      };
      return { isUpdateAvailable: true, updateInfo };
    });
    autoUpdaterMock.getOrCreateDownloadHelper.mockResolvedValue({
      cacheDirForPendingUpdate: '/cache/pending',
      validateDownloadedPath,
    });
    autoUpdaterMock.downloadUpdate.mockResolvedValue(undefined);

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    await expect(autoUpdaterService.restoreDownloadedUpdateIfAvailable()).resolves.toEqual({
      success: true,
      data: {
        ready: true,
        version: '2.1.14',
        currentVersion: '2.1.13',
        filePath: cachedUpdatePath,
      },
    });
    expect(validateDownloadedPath).toHaveBeenCalledWith(cachedUpdatePath, updateInfo, fileInfo, expect.anything());
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not restore a cached auto-update when the downloaded package is missing or invalid', async () => {
    const updateInfo = {
      version: '2.1.14',
      files: [{ url: 'AionUi-2.1.14-mac.zip', sha512: 'sha512-value' }],
      path: 'AionUi-2.1.14-mac.zip',
      sha512: 'sha512-value',
      releaseDate: '2026-06-08T00:00:00.000Z',
    };
    const fileInfo = {
      url: new URL('https://static.aionui.com/releases/2.1.14/AionUi-2.1.14-mac.zip'),
      info: { url: 'AionUi-2.1.14-mac.zip', sha512: 'sha512-value' },
    };
    const validateDownloadedPath = vi.fn().mockResolvedValue(null);

    autoUpdaterMock.checkForUpdates.mockImplementation(async () => {
      (autoUpdaterMock as { updateInfoAndProvider?: unknown }).updateInfoAndProvider = {
        info: updateInfo,
        provider: { resolveFiles: vi.fn(() => [fileInfo]) },
      };
      return { isUpdateAvailable: true, updateInfo };
    });
    autoUpdaterMock.getOrCreateDownloadHelper.mockResolvedValue({
      cacheDirForPendingUpdate: '/cache/pending',
      validateDownloadedPath,
    });

    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
    autoUpdaterService.initialize();

    await expect(autoUpdaterService.restoreDownloadedUpdateIfAvailable()).resolves.toEqual({
      success: true,
      data: { ready: false },
    });
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('waits on macOS when service downloaded but native install readiness has not arrived', async () => {
    setPlatform('darwin');
    const cleanup = vi.fn(async () => ({ ok: true as const, rollback: async () => {} }));
    const statuses: Array<{ status: string; error?: string }> = [];
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(cleanup);
    autoUpdaterService.on('update-status', (status: { status: string; error?: string }) => statuses.push(status));
    getUpdateDownloadedHandler()({ version: '2.2.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();

    expect(statuses.some((status) => status.status === 'preparing-install')).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    getNativeUpdateDownloadedHandler()();
    await installPromise;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('does not quit on macOS when native updater reports readiness error first', async () => {
    setPlatform('darwin');
    const statuses: Array<{ status: string; error?: string }> = [];
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.on('update-status', (status: { status: string; error?: string }) => statuses.push(status));
    getUpdateDownloadedHandler()({ version: '2.2.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();
    getNativeErrorHandler()(new Error('native failed'));

    await expect(installPromise).rejects.toThrow('update.errors.prepareInstallFailed');
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({
      status: 'error',
      error: 'update.errors.prepareInstallFailed',
    });
  });

  it('does not quit on macOS when native updater readiness times out', async () => {
    setPlatform('darwin');
    vi.useFakeTimers();
    const statuses: Array<{ status: string; error?: string }> = [];
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.on('update-status', (status: { status: string; error?: string }) => statuses.push(status));
    getUpdateDownloadedHandler()({ version: '2.2.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();
    const installRejection = expect(installPromise).rejects.toThrow('update.errors.prepareInstallTimeout');
    await vi.advanceTimersByTimeAsync(60_000);

    await installRejection;
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({
      status: 'error',
      error: 'update.errors.prepareInstallTimeout',
    });
  });

  it('resets macOS native readiness when a new update check starts', async () => {
    setPlatform('darwin');
    const cleanup = vi.fn(async () => ({ ok: true as const, rollback: async () => {} }));
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(cleanup);
    getUpdateDownloadedHandler()({ version: '2.2.0' });
    getNativeUpdateDownloadedHandler()();
    getCheckingForUpdateHandler()();
    getUpdateDownloadedHandler()({ version: '2.3.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();

    expect(cleanup).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    getNativeUpdateDownloadedHandler()();
    await installPromise;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('rejects a pending macOS install wait when a new update check starts', async () => {
    setPlatform('darwin');
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    getUpdateDownloadedHandler()({ version: '2.2.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();
    const installRejection = expect(installPromise).rejects.toThrow('update.errors.prepareInstallFailed');

    getCheckingForUpdateHandler()();

    await installRejection;
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('defers safely when pre-install check fails after macOS readiness', async () => {
    setPlatform('darwin');
    const cleanupError = new Error('cleanup failed');
    const statuses: Array<{ status: string; error?: string }> = [];
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(async () => {
      throw cleanupError;
    });
    autoUpdaterService.on('update-status', (status: { status: string; error?: string }) => statuses.push(status));
    getUpdateDownloadedHandler()({ version: '2.2.0' });

    const installPromise = autoUpdaterService.quitAndInstall();
    await Promise.resolve();
    getNativeUpdateDownloadedHandler()();

    await expect(installPromise).resolves.toEqual({ status: 'deferred', reason: 'unavailable' });
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not force exit when quitAndInstall handoff throws', async () => {
    setPlatform('darwin');
    const statuses: Array<{ status: string; error?: string }> = [];
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('handoff failed');
    });
    autoUpdaterService.initialize();
    const rollback = vi.fn(async () => {});
    autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: true, rollback }));
    autoUpdaterService.on('update-status', (status: { status: string; error?: string }) => statuses.push(status));
    getUpdateDownloadedHandler()({ version: '2.2.0' });
    getNativeUpdateDownloadedHandler()();

    await expect(autoUpdaterService.quitAndInstall()).resolves.toEqual({ status: 'deferred', reason: 'unknown' });
    expect(rollback).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });

  it('keeps non-macOS quitAndInstall behavior immediate', async () => {
    setPlatform('win32');
    const cleanup = vi.fn(async () => ({ ok: true as const, rollback: async () => {} }));
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(cleanup);

    await autoUpdaterService.quitAndInstall();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.install).toHaveBeenCalledWith(true, true);
  });

  it('uses a silent handoff with relaunch and does not install automatically on ordinary quit', async () => {
    setPlatform('win32');
    const cleanup = vi.fn(async () => ({ ok: true as const, rollback: async () => {} }));
    const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');

    autoUpdaterService.initialize();
    autoUpdaterService.setBeforeQuitAndInstall(cleanup);
    autoUpdaterMock.autoRunAppAfterInstall = false;

    await autoUpdaterService.quitAndInstall();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdaterMock.install).toHaveBeenCalledWith(true, true);
  });

  it('moves the process cwd to temp before the Windows updater handoff', async () => {
    setPlatform('win32');
    const tempRoot = path.join(process.env.TEMP || process.cwd(), `aionui-updater-cwd-test-${process.pid}`);
    const expectedCwd = path.join(tempRoot, 'thor-updater-cwd');
    const chdir = vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
    appMock.getPath.mockImplementation((name: string) => (name === 'temp' ? tempRoot : '/tmp/aionui-test'));

    try {
      const { autoUpdaterService } = await import('@/process/services/autoUpdaterService');
      autoUpdaterService.initialize();
      autoUpdaterService.setBeforeQuitAndInstall(async () => ({ ok: true, rollback: async () => {} }));

      await autoUpdaterService.quitAndInstall();

      expect(chdir).toHaveBeenCalledWith(expectedCwd);
      expect(autoUpdaterMock.install).toHaveBeenCalledWith(true, true);
    } finally {
      chdir.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
