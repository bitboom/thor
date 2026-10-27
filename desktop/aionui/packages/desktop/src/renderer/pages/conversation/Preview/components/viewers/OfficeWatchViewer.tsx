/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { getBaseUrl, isBackendHttpError } from '@/common/adapter/httpBridge';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { registerTabReloader } from '../../context/tabReloaderRegistry';
import { openExternalUrl } from '@/renderer/utils/platform';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { Button, Spin } from '@arco-design/web-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type DocType = 'ppt' | 'word' | 'excel';
type OfficeWatchErrorCode =
  | 'OFFICECLI_NOT_FOUND'
  | 'OFFICECLI_INSTALL_FAILED'
  | 'OFFICECLI_PORT_TIMEOUT'
  | 'OFFICECLI_START_FAILED'
  | 'OFFICECLI_BUNDLE_MISSING'
  | 'OFFICECLI_INTEGRITY_FAILED'
  | 'OFFICECLI_READONLY_REQUIRED'
  | 'PATH_OUTSIDE_SANDBOX';

const BRIDGE = {
  ppt: ipcBridge.pptPreview,
  word: ipcBridge.wordPreview,
  excel: ipcBridge.excelPreview,
} as const;

// Web-server proxy base paths (Electron uses the direct localhost URL instead)
const PROXY_PATH: Record<DocType, string> = {
  ppt: '/api/ppt-proxy',
  word: '/api/office-watch-proxy',
  excel: '/api/office-watch-proxy',
};

const IFRAME_TITLE: Record<DocType, string> = {
  ppt: 'PPT Preview',
  word: 'Word Preview',
  excel: 'Excel Preview',
};

const I18N_KEYS = {
  ppt: {
    loading: 'preview.ppt.loading',
    installing: 'preview.ppt.installing',
    startFailed: 'preview.ppt.startFailed',
    installHint: 'preview.ppt.installHint',
  },
  word: {
    loading: 'preview.word.watch.loading',
    installing: 'preview.word.watch.installing',
    startFailed: 'preview.word.watch.startFailed',
    installHint: 'preview.word.watch.installHint',
  },
  excel: {
    loading: 'preview.excel.watch.loading',
    installing: 'preview.excel.watch.installing',
    startFailed: 'preview.excel.watch.startFailed',
    installHint: 'preview.excel.watch.installHint',
  },
} as const;

const OFFICE_ERROR_I18N_KEYS: Record<OfficeWatchErrorCode, string> = {
  OFFICECLI_NOT_FOUND: 'preview.office.errors.officecliNotFound',
  OFFICECLI_INSTALL_FAILED: 'preview.office.errors.installFailed',
  OFFICECLI_PORT_TIMEOUT: 'preview.office.errors.portTimeout',
  OFFICECLI_START_FAILED: 'preview.office.errors.startFailed',
  OFFICECLI_BUNDLE_MISSING: 'preview.office.errors.bundleMissing',
  OFFICECLI_INTEGRITY_FAILED: 'preview.office.errors.integrityFailed',
  OFFICECLI_READONLY_REQUIRED: 'preview.office.errors.readOnlyRequired',
  PATH_OUTSIDE_SANDBOX: 'preview.office.errors.outsideSandbox',
};

export const OFFICECLI_INSTALL_URL = 'https://github.com/bitboom/thor/releases';

interface OfficeWatchViewerProps {
  docType: DocType;
  tabId?: string;
  // Preferred identity: the backend resolves pe→path and keys the watch by it, so
  // start/stop match even when the tab has no device path (explorer office files).
  fileRef?: ChatFileRef;
  file_path?: string;
  content?: string;
  workspace?: string;
}

interface OfficeWatchErrorState {
  code?: OfficeWatchErrorCode;
  message: string;
}

export function resolveOfficeWatchUrl(url: string, docType: DocType): string {
  const proxyMatch = url.match(/^\/api\/(?:office-watch-proxy|ppt-proxy)\/(\d+)(\/.*)?$/);
  if (proxyMatch && isElectronDesktop()) {
    const [, port, suffix] = proxyMatch;
    return `http://127.0.0.1:${port}${suffix || '/'}`;
  }

  if (url.startsWith('/')) {
    if (!isElectronDesktop()) {
      const proxyPortMatch = url.match(/^\/api\/(?:office-watch-proxy|ppt-proxy)\/(\d+)(\/.*)?$/);
      if (proxyPortMatch) {
        const [, port, suffix] = proxyPortMatch;
        // The backend registers /{port} and /{port}/{*path} only; a bare
        // trailing slash matches neither route and 404s (#3212), so emit a
        // suffix only when it carries a real sub-path.
        const subPath = suffix && suffix !== '/' ? suffix : '';
        return `${PROXY_PATH[docType]}/${port}${subPath}`;
      }
    }
    return `${getBaseUrl()}${url}`;
  }

  if (!isElectronDesktop()) {
    const parsed = new URL(url);
    return `${PROXY_PATH[docType]}/${parsed.port}`;
  }

  return url;
}

function normalizeOfficeWatchErrorCode(error?: string | null): OfficeWatchErrorCode | undefined {
  switch (error) {
    case 'OFFICECLI_NOT_FOUND':
    case 'OFFICECLI_INSTALL_FAILED':
    case 'OFFICECLI_PORT_TIMEOUT':
    case 'OFFICECLI_START_FAILED':
    case 'OFFICECLI_BUNDLE_MISSING':
    case 'OFFICECLI_INTEGRITY_FAILED':
    case 'OFFICECLI_READONLY_REQUIRED':
    case 'PATH_OUTSIDE_SANDBOX':
      return error;
    default:
      return undefined;
  }
}

// Thor does not support repairing the pinned derivative with a global install.
export const OFFICECLI_SERVER_INSTALL_COMMAND = '';

export function resolveOfficeErrorActions(
  code: OfficeWatchErrorCode | undefined,
  isElectron: boolean
): { showServerInstallGuide: boolean; showInstallLink: boolean; showRetry: boolean } {
  const officecliMissing = isBundleError(code);
  return {
    showServerInstallGuide: false,
    showInstallLink: isElectron && officecliMissing,
    showRetry: officecliMissing || code === 'OFFICECLI_PORT_TIMEOUT',
  };
}

function isBundleError(code: OfficeWatchErrorCode | undefined): boolean {
  return (
    code === 'OFFICECLI_NOT_FOUND' ||
    code === 'OFFICECLI_INSTALL_FAILED' ||
    code === 'OFFICECLI_BUNDLE_MISSING' ||
    code === 'OFFICECLI_INTEGRITY_FAILED' ||
    code === 'OFFICECLI_READONLY_REQUIRED'
  );
}

export function officeBundleErrorText(code: OfficeWatchErrorCode | undefined): string {
  switch (code) {
    case 'OFFICECLI_BUNDLE_MISSING':
      return 'The bundled Office preview component is missing.';
    case 'OFFICECLI_INTEGRITY_FAILED':
      return 'The bundled Office preview component failed its integrity check.';
    case 'OFFICECLI_READONLY_REQUIRED':
      return 'The bundled Office preview component does not support the required read-only mode.';
    default:
      return 'The verified Office preview bundle is missing or unavailable.';
  }
}

/**
 * Shared Office watch viewer.
 *
 * Launches an `officecli watch` child process via IPC, waits for the local
 * HTTP server to be ready, then renders it in a webview (Electron) or iframe
 * (web server mode). Cleans up the process on unmount.
 *
 * Used by PptViewer, OfficeDocViewer, and ExcelViewer — each passes its
 * docType to select the correct IPC bridge, proxy path, and i18n keys.
 */
const OfficeWatchViewer: React.FC<OfficeWatchViewerProps> = ({ docType, tabId, fileRef, file_path, workspace }) => {
  const { t } = useTranslation();
  const keys = I18N_KEYS[docType];

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => (tabId ? registerTabReloader(tabId, () => setReloadKey((n) => n + 1)) : undefined), [tabId]);
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const partition = useMemo(() => 'thor-office-' + crypto.randomUUID(), [watchUrl]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'starting' | 'installing'>('starting');
  const [error, setError] = useState<OfficeWatchErrorState | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // Mirror both identities for the unmount cleanup; stop prefers the ref.
  const file_pathRef = useRef(file_path);
  const fileRefRef = useRef(fileRef);

  useEffect(() => {
    file_pathRef.current = file_path;
    fileRefRef.current = fileRef;
    const bridge = BRIDGE[docType];

    // A ChatFileRef alone is enough (explorer office tabs have no device path).
    if (!fileRef && !file_path) {
      setLoading(false);
      setError({ message: t('preview.errors.missingFilePath') });
      return;
    }

    let cancelled = false;

    const unsubStatus = bridge.status.on((evt) => {
      if (cancelled) return;
      if (evt.state === 'installing') setStatus('installing');
      else if (evt.state === 'starting') setStatus('starting');
    });

    const start = async () => {
      setLoading(true);
      setStatus('starting');
      setError(null);
      try {
        const result = await bridge.start.invoke({ file_path, workspace, file: fileRef });
        const errorCode = normalizeOfficeWatchErrorCode(result.error);
        if (errorCode) {
          setError({
            code: errorCode,
            message: t(OFFICE_ERROR_I18N_KEYS[errorCode]),
          });
          setLoading(false);
          return;
        }

        const url = result.url;
        if (!url) {
          throw new Error(t(keys.startFailed));
        }
        // Small delay to ensure the watch HTTP server is fully ready for the webview
        await new Promise((r) => setTimeout(r, 300));
        if (!cancelled) {
          const resolvedUrl = resolveOfficeWatchUrl(url, docType);
          setWatchUrl(resolvedUrl);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          const backendCode = isBackendHttpError(err) ? normalizeOfficeWatchErrorCode(err.code) : undefined;
          if (backendCode) {
            setError({
              code: backendCode,
              message: t(OFFICE_ERROR_I18N_KEYS[backendCode]),
            });
            setLoading(false);
            return;
          }
          const msg = err instanceof Error ? err.message : t(keys.startFailed);
          setError({ message: msg });
          setLoading(false);
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      unsubStatus();
      // Stop the same identity we started (backend prefers `file`), so the watch
      // session is matched and the officecli subprocess is not leaked.
      if (fileRefRef.current || file_pathRef.current) {
        bridge.stop.invoke({ file_path: file_pathRef.current, file: fileRefRef.current }).catch(() => {});
      }
    };
  }, [docType, fileRef, file_path, retryKey, t, workspace]);

  if (loading) {
    return (
      <div className='h-full w-full flex items-center justify-center bg-bg-1'>
        <div className='flex flex-col items-center gap-12px'>
          <Spin size={32} />
          <span className='text-13px text-t-secondary'>
            {status === 'installing' ? t(keys.installing) : t(keys.loading)}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    const { showServerInstallGuide, showInstallLink, showRetry } = resolveOfficeErrorActions(
      error.code,
      isElectronDesktop()
    );

    return (
      <div className='h-full w-full flex items-center justify-center bg-bg-1'>
        <div className='text-center max-w-400px'>
          <div className='text-16px text-danger mb-8px'>
            {isBundleError(error.code)
              ? t(
                  error.code === 'OFFICECLI_BUNDLE_MISSING' ||
                    error.code === 'OFFICECLI_INTEGRITY_FAILED' ||
                    error.code === 'OFFICECLI_READONLY_REQUIRED'
                    ? OFFICE_ERROR_I18N_KEYS[error.code]
                    : 'preview.office.bundleUnavailable',
                  {
                    defaultValue: officeBundleErrorText(error.code),
                  }
                )
              : error.message}
          </div>
          {!isElectronDesktop() && isBundleError(error.code) && (
            <div>
              {t('preview.office.desktopRequired', {
                defaultValue: 'Office bundle repair is supported in Thor desktop.',
              })}
            </div>
          )}
          {!error.code && (
            <div className='text-12px text-t-secondary mb-12px'>
              {t('preview.office.thorRepair', {
                defaultValue: 'Reinstall or update Thor to restore its bundled Office preview.',
              })}
            </div>
          )}
          {showServerInstallGuide && (
            <div className='text-start mb-12px'>
              <div className='text-12px text-t-secondary mb-8px'>{t('preview.office.serverInstall.hint')}</div>
              <code className='block select-all rounded-8px bg-2 px-10px py-8px text-12px text-t-primary'>
                {OFFICECLI_SERVER_INSTALL_COMMAND}
              </code>
              <div className='text-12px text-t-secondary mt-8px'>{t('preview.office.serverInstall.icuNote')}</div>
            </div>
          )}
          {showInstallLink && (
            <div className='flex justify-center'>
              <Button type='text' size='small' onClick={() => void openExternalUrl(OFFICECLI_INSTALL_URL)}>
                {t('preview.office.thorRepair', {
                  defaultValue: 'Reinstall or update Thor to restore its bundled Office preview.',
                })}
              </Button>
            </div>
          )}
          {showRetry && (
            <div className='flex justify-center'>
              <Button size='small' type='primary' onClick={() => setRetryKey((value) => value + 1)}>
                {t('common.retry', { defaultValue: 'Retry' })}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!watchUrl) return null;

  // Electron: use <webview> via WebviewHost for full Electron integration.
  // Web server mode: use <iframe> since <webview> is Electron-only.
  if (isElectronDesktop()) {
    return (
      <div className='h-full flex flex-col'>
        <div className='px-12px py-6px text-12px text-t-secondary bg-fill-1'>{t('preview.office.readOnlyNotice')}</div>
        <div className='flex-1 min-h-0'>
          <WebviewHost key={`${watchUrl}-${reloadKey}`} url={watchUrl} partition={partition} className='bg-bg-1' />
        </div>
      </div>
    );
  }
  return (
    <iframe key={reloadKey} src={watchUrl} className='w-full h-full border-0 bg-bg-1' title={IFRAME_TITLE[docType]} />
  );
};

export default OfficeWatchViewer;
