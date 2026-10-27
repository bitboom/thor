/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScrollSyncTarget } from '../../hooks/useScrollSyncHelpers';
import { generateInspectScript } from './htmlInspectScript';

/** 选中元素的数据结构 / Selected element data structure */
export interface InspectedElement {
  /** 完整 HTML / Full HTML */
  html: string;
  /** 简化标签名 / Simplified tag name */
  tag: string;
}

interface HTMLRendererProps {
  content: string;
  file_path?: string;
  workspace?: string;
  isDirty?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (scrollTop: number, scrollHeight: number, clientHeight: number) => void;
  inspectMode?: boolean; // 是否开启检查模式 / Whether inspect mode is enabled
  copySuccessMessage?: string;
  /** 元素选中回调 / Element selected callback */
  onElementSelected?: (element: InspectedElement) => void;
}

// Electron webview 元素的类型定义 / Type definition for Electron webview element
interface ElectronWebView extends HTMLElement {
  src: string;
  executeJavaScript: (code: string) => Promise<void>;
}

type HtmlPreviewSourceKind = 'file' | 'data';
type HtmlPreviewLogLevel = 'info' | 'warn' | 'error';

function logHtmlPreview(level: HtmlPreviewLogLevel, message: string, data?: unknown): void {
  const rendererLogger = ipcBridge.application?.writeRendererLog;
  if (!rendererLogger) return;

  void rendererLogger
    .invoke({
      level,
      tag: 'HTMLRenderer',
      message,
      data,
    })
    .catch((error: unknown) => {
      console.warn('[HTMLRenderer] Failed to write renderer log:', error);
    });
}

function getFileNameFromPath(filePath?: string): string | undefined {
  return filePath?.split(/[\\/]/).pop() || undefined;
}

function summarizePreviewUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('data:')) {
    return `data:text/html (${url.length} chars)`;
  }
  if (url.startsWith('file://')) {
    return `file://${getFileNameFromPath(url) ?? ''}`;
  }
  return url;
}

/**
 * 判断绝对路径是否在可信根目录内（纯字符串实现，renderer 不可用 node:path）。
 * 通过比较路径段前缀实现，避免 `..`/`../` 逃逸。
 */
function isWithinRoot(root: string, target: string): boolean {
  if (!root) return true;
  const rootParts = root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  const targetParts = target.replace(/\\/g, '/').split('/').filter(Boolean);
  if (rootParts.length === 0) return true;
  if (targetParts.length < rootParts.length) return false;
  return rootParts.every((part, i) => part === targetParts[i]);
}

/**
 * 归一化绝对路径中的 `.`/`..` 段（纯字符串，renderer 不可用 node:path）。
 * 保留 POSIX 根 `/` 与 Windows 盘符前缀。
 * Normalize `.`/`..` segments in an absolute path (pure string; the renderer
 * cannot use node:path). Preserves the POSIX root `/` and the Windows drive prefix.
 */
function normalizeAbsolute(path: string): string {
  const unified = path.replace(/\\/g, '/');
  const isWindowsDrive = /^[a-zA-Z]:/.test(unified);
  const stack: string[] = [];
  for (const segment of unified.split('/').filter(Boolean)) {
    if (segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return isWindowsDrive ? stack.join('/') : '/' + stack.join('/');
}

/**
 * 解析相对路径为绝对路径 / Resolve relative path to absolute path
 * @param basePath 基础文件路径 / Base file path
 * @param relativePath 相对路径 / Relative path
 * @param workspace 可信工作区根目录（可选）/ Trusted workspace root (optional)
 * @returns 绝对路径 / Absolute path
 */
export function resolveRelativePath(basePath: string, relativePath: string, workspace?: string): string {
  // 去除协议前缀 / Remove protocol prefix
  const cleanBasePath = basePath.replace(/^file:\/\//, '');
  const baseDir =
    cleanBasePath.substring(0, cleanBasePath.lastIndexOf('/') + 1) ||
    cleanBasePath.substring(0, cleanBasePath.lastIndexOf('\\') + 1);

  // 如果相对路径已经是绝对路径 / If relative path is already absolute
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    // 先归一化 `.`/`..` 段再做边界检查，避免形如 `<workspace>/../../secret`
    // 的字面遍历：它以工作区前缀开头却实际逃逸，未归一时会骗过 isWithinRoot。
    // Normalize `.`/`..` before the boundary check: a literal
    // `<workspace>/../../secret` starts with the workspace prefix yet escapes
    // it, so an un-normalized string would slip past isWithinRoot.
    const normalizedAbsolute = normalizeAbsolute(relativePath);
    if (workspace && !isWithinRoot(workspace, normalizedAbsolute)) {
      throw new Error(`Path traversal blocked: "${relativePath}" resolves outside workspace`);
    }
    return normalizedAbsolute;
  }

  // 处理 ./ 和 ../ / Handle ./ and ../
  const parts = baseDir.replace(/\\/g, '/').split('/').filter(Boolean);
  const relParts = relativePath.replace(/\\/g, '/').split('/');

  for (const part of relParts) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }

  // 保留 Windows 盘符格式 / Preserve Windows drive letter format
  const result = /^[a-zA-Z]:/.test(baseDir) ? parts.join('/') : '/' + parts.join('/');

  // 相对路径解析结果必须落在可信工作区内，否则视为逃逸
  if (workspace && !isWithinRoot(workspace, result)) {
    throw new Error(`Path traversal blocked: "${relativePath}" resolves outside workspace`);
  }
  return result;
}

/**
 * HTML 渲染器组件
 * HTML renderer component
 *
 * 在 iframe/webview 中渲染 HTML 内容（自动检测环境）
 * Renders HTML content in iframe/webview (auto-detect environment)
 */
const HTMLRenderer: React.FC<HTMLRendererProps> = ({
  content,
  file_path,
  workspace,
  isDirty = false,
  containerRef,
  onScroll,
  inspectMode = false,
  copySuccessMessage,
  onElementSelected,
}) => {
  const partition = useMemo(() => 'thor-html-' + crypto.randomUUID(), [content]);
  const divRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<ElectronWebView | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const webviewLoadedRef = useRef(false); // 跟踪 webview 是否已加载 / Track if webview is loaded
  const lastLoggedSourceRef = useRef<string | null>(null);
  const isSyncingScrollRef = useRef(false); // 防止滚动同步循环 / Prevent scroll sync loops
  const [webviewContentHeight, setWebviewContentHeight] = useState(0); // webview 内容高度 / webview content height
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });

  // 检测是否在 Electron 环境 / Detect if in Electron environment
  const isElectron = useMemo(() => typeof window !== 'undefined' && window.electronAPI !== undefined, []);

  // 监听主题变化 / Monitor theme changes
  useEffect(() => {
    const updateTheme = () => {
      const theme = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
      setCurrentTheme(theme);
    };

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  // Deny external resources even in the browser iframe. The desktop guest also
  // enforces this in its Electron session, including top-level navigation.
  const policy =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\">";
  const doctype = content.match(/^\s*<!doctype[^>]*>/i)?.[0];
  const isolatedHtml = doctype ? doctype + policy + content.slice(doctype.length) : policy + content;
  const browserHtmlContent = isolatedHtml;

  // 计算 webview 的 src
  // Calculate webview src
  // Keep untrusted HTML in an opaque origin; relative local assets and network
  // requests are deliberately unavailable in the desktop preview.
  const webviewSrc = useMemo(() => 'data:text/html;charset=utf-8,' + encodeURIComponent(isolatedHtml), [isolatedHtml]);

  const webviewSourceKind: HtmlPreviewSourceKind = 'data';
  const webviewSourceReason = useMemo(() => {
    if (!file_path) return 'inline-content';
    if (isDirty) return 'dirty-content';
    return 'memory-preview';
  }, [file_path, isDirty]);

  useEffect(() => {
    if (!isElectron) return;

    const sourceLogKey = `${webviewSourceKind}:${webviewSourceReason}:${file_path ?? ''}:${String(isDirty)}`;
    if (lastLoggedSourceRef.current === sourceLogKey) return;
    lastLoggedSourceRef.current = sourceLogKey;

    logHtmlPreview('info', 'html_preview_source_selected', {
      source: webviewSourceKind,
      reason: webviewSourceReason,
      fileName: getFileNameFromPath(file_path),
      hasFilePath: Boolean(file_path),
      isDirty: Boolean(isDirty),
      contentLength: content.length,
      src: summarizePreviewUrl(webviewSrc),
    });
  }, [content.length, file_path, isDirty, isElectron, webviewSourceKind, webviewSourceReason, webviewSrc]);

  // 当 webviewSrc 改变时重置加载状态 / Reset loading state when webviewSrc changes
  useEffect(() => {
    webviewLoadedRef.current = false;
  }, [webviewSrc]);

  // 监听 webview 加载完成
  // 依赖 webviewSrc 确保 webview 重新挂载时重新添加监听器
  // Depend on webviewSrc to ensure listeners are re-added when webview remounts
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDidFinishLoad = () => {
      webviewLoadedRef.current = true; // 标记为已加载 / Mark as loaded
    };

    const handleDidFailLoad = (event: Event) => {
      const loadEvent = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };

      logHtmlPreview('error', 'html_preview_webview_failed_load', {
        errorCode: loadEvent.errorCode,
        errorDescription: loadEvent.errorDescription,
        isMainFrame: loadEvent.isMainFrame,
        url: summarizePreviewUrl(loadEvent.validatedURL || webviewSrc),
      });
    };

    webview.addEventListener('did-finish-load', handleDidFinishLoad);
    webview.addEventListener('did-fail-load', handleDidFailLoad);

    return () => {
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
      webview.removeEventListener('did-fail-load', handleDidFailLoad);
    };
  }, [webviewSrc]);

  // 生成检查模式注入脚本 / Generate inspect mode injection script
  // 使用 useMemo 缓存，只在 inspectMode 改变时重新生成 / Use useMemo to cache, only regenerate when inspectMode changes
  const copySuccessText = useMemo(() => copySuccessMessage ?? '✓ Copied HTML snippet', [copySuccessMessage]);
  const inspectScript = useMemo(
    () => generateInspectScript(inspectMode, { copySuccess: copySuccessText }),
    [inspectMode, copySuccessText]
  );

  // 执行脚本注入的函数 / Function to execute script injection
  // 使用 useCallback 缓存，避免每次渲染都创建新函数 / Use useCallback to cache, avoid creating new function on each render
  const executeScript = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    // executeJavaScript 返回 Promise，需要处理 / executeJavaScript returns Promise, need to handle it
    void webview
      .executeJavaScript(inspectScript)
      .then(() => {
        // Script injected successfully
      })
      .catch((_error) => {
        // Failed to inject inspect script
      });
  }, [inspectScript, inspectMode]);

  // 注入检查模式脚本 / Inject inspect mode script
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    // 如果 webview 已经加载完成，立即执行脚本 / If webview is already loaded, execute script immediately
    if (webviewLoadedRef.current) {
      executeScript();
    }

    // 同时监听未来的页面加载事件 / Also listen for future page loads
    const handleLoad = () => {
      executeScript();
    };

    webview.addEventListener('did-finish-load', handleLoad);

    return () => {
      webview.removeEventListener('did-finish-load', handleLoad);
    };
  }, [executeScript]);

  // 监听 webview 控制台消息，捕获检查元素事件和滚动事件
  // Listen for webview console messages to capture inspect element events and scroll events
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleConsoleMessage = (event: Event) => {
      const consoleEvent = event as Event & {
        level?: number;
        line?: number;
        message?: string;
        sourceId?: string;
      };
      const message = consoleEvent.message;

      if (typeof message === 'string') {
        // 处理检查元素消息 / Handle inspect element message
        if (message.startsWith('__INSPECT_ELEMENT__') && inspectMode && onElementSelected) {
          try {
            const jsonStr = message.slice('__INSPECT_ELEMENT__'.length);
            const data = JSON.parse(jsonStr) as InspectedElement;
            onElementSelected(data);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse inspect element message:', e);
          }
        }
        // 处理滚动消息 / Handle scroll message
        else if (message.startsWith('__SCROLL_SYNC__') && onScroll) {
          if (isSyncingScrollRef.current) return; // 防止循环 / Prevent loop
          try {
            const jsonStr = message.slice('__SCROLL_SYNC__'.length);
            const data = JSON.parse(jsonStr) as { scrollTop: number; scrollHeight: number; clientHeight: number };
            onScroll(data.scrollTop, data.scrollHeight, data.clientHeight);
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse scroll message:', e);
          }
        }
        // 处理内容高度消息 / Handle content height message
        else if (message.startsWith('__CONTENT_HEIGHT__')) {
          try {
            const height = parseInt(message.slice('__CONTENT_HEIGHT__'.length), 10);
            if (!isNaN(height) && height > 0) {
              setWebviewContentHeight(height);
            }
          } catch (e) {
            console.warn('[HTMLRenderer] Failed to parse content height message:', e);
          }
        }
      }
    };

    webview.addEventListener('console-message', handleConsoleMessage);

    return () => {
      webview.removeEventListener('console-message', handleConsoleMessage);
    };
  }, [inspectMode, onElementSelected, onScroll]);

  // 注入滚动监听脚本 / Inject scroll listener script
  const scrollSyncScript = useMemo(
    () => `
    (function() {
      if (window.__scrollSyncInitialized) return;
      window.__scrollSyncInitialized = true;

      // 发送内容高度 / Send content height
      function sendContentHeight() {
        const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        console.log('__CONTENT_HEIGHT__' + scrollHeight);
      }

      // 初始发送 / Initial send
      sendContentHeight();

      // 监听内容变化 / Listen for content changes
      const resizeObserver = new ResizeObserver(sendContentHeight);
      resizeObserver.observe(document.body);

      let scrollTimeout;
      window.addEventListener('scroll', function() {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(function() {
          const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
          const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          const clientHeight = window.innerHeight || document.documentElement.clientHeight;
          console.log('__SCROLL_SYNC__' + JSON.stringify({ scrollTop, scrollHeight, clientHeight }));
        }, 16); // ~60fps throttle
      }, { passive: true });
    })();
  `,
    []
  );

  // 注入滚动同步脚本 / Inject scroll sync script
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !onScroll) return;

    const injectScrollSync = () => {
      void webview.executeJavaScript(scrollSyncScript).catch(() => {});
    };

    if (webviewLoadedRef.current) {
      injectScrollSync();
    }

    webview.addEventListener('did-finish-load', injectScrollSync);

    return () => {
      webview.removeEventListener('did-finish-load', injectScrollSync);
    };
  }, [scrollSyncScript, onScroll]);

  // 监听外部滚动同步请求 / Listen for external scroll sync requests
  const handleTargetScroll = useCallback((targetPercent: number) => {
    const webview = webviewRef.current;
    if (!webview || !webviewLoadedRef.current) return;

    void webview
      .executeJavaScript(
        `
          (function() {
            const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
            const clientHeight = window.innerHeight || document.documentElement.clientHeight;
            const targetScroll = ${targetPercent} * (scrollHeight - clientHeight);
            window.scrollTo({ top: targetScroll, behavior: 'auto' });
          })();
        `
      )
      .catch(() => {});
  }, []);
  // 使用外部 containerRef 或内部 divRef / Use external containerRef or internal divRef
  const effectiveContainerRef = containerRef || divRef;
  useScrollSyncTarget(effectiveContainerRef, handleTargetScroll);

  // 监听容器滚动，同步到 webview / Listen to container scroll, sync to webview
  useEffect(() => {
    const container = containerRef?.current || divRef.current;
    if (!container) return;

    const handleContainerScroll = () => {
      if (isSyncingScrollRef.current) return;

      const webview = webviewRef.current;
      if (!webview || !webviewLoadedRef.current) return;

      isSyncingScrollRef.current = true;
      const scrollPercentage = container.scrollTop / (container.scrollHeight - container.clientHeight || 1);

      void webview
        .executeJavaScript(
          `
          (function() {
            const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
            const clientHeight = window.innerHeight || document.documentElement.clientHeight;
            const targetScroll = ${scrollPercentage} * (scrollHeight - clientHeight);
            window.scrollTo({ top: targetScroll, behavior: 'auto' });
          })();
        `
        )
        .catch(() => {})
        .finally(() => {
          setTimeout(() => {
            isSyncingScrollRef.current = false;
          }, 50);
        });
    };

    container.addEventListener('scroll', handleContainerScroll);
    return () => container.removeEventListener('scroll', handleContainerScroll);
  }, [containerRef]);

  // 计算代理滚动层的高度 / Calculate proxy scroll layer height
  const proxyHeight = webviewContentHeight > 0 ? webviewContentHeight : '100%';

  return (
    <div
      ref={containerRef || divRef}
      className={`h-full w-full overflow-auto relative ${currentTheme === 'dark' ? 'bg-bg-1' : 'bg-white'}`}
    >
      {isElectron ? (
        <>
          {/* 代理滚动层：使容器可滚动 / Proxy scroll layer: makes container scrollable */}
          <div style={{ height: proxyHeight, width: '100%', pointerEvents: 'none' }} />
          {/* webview 固定在容器顶部 / webview fixed at container top */}
          {/* key 确保内容改变时 webview 重新挂载 / key ensures webview remounts when content changes */}
          <webview
            key={webviewSrc}
            ref={webviewRef}
            src={webviewSrc}
            className='w-full border-0'
            style={{
              display: 'inline-flex',
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              height: '100%',
            }}
            partition={partition}
            webpreferences='contextIsolation=yes, nodeIntegration=no, sandbox=yes, webSecurity=yes'
          />
        </>
      ) : (
        <iframe
          ref={iframeRef}
          srcDoc={browserHtmlContent}
          className='w-full h-full border-0'
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
          }}
          sandbox=''
        />
      )}
    </div>
  );
};

export default HTMLRenderer;
