/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  AutoUpdateReadyResult,
  UpdateCheckResult,
  UpdateReleaseInfo,
  GitHubReleaseAsset,
  InstallerLastFailureMarker,
} from '@/common/update/updateTypes';
import { app } from 'electron';
import log from 'electron-log';
import { load as loadYaml } from 'js-yaml';
import * as path from 'path';
import semver from 'semver';
import { autoUpdaterService } from '../services/autoUpdaterService';
import { consumeInstallerLastFailure } from '../services/installerLastFailure';

/** Lazily loads i18n to avoid pulling in initStorage chain at module load time */
let _i18nCache: Promise<typeof import('../services/i18n')> | null = null;
const getI18n = async () => {
  if (!_i18nCache) {
    _i18nCache = import('../services/i18n');
  }
  const m = await _i18nCache;
  return m.default;
};

type GitHubReleaseApiAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  content_type?: string;
};

type GitHubReleaseApi = {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
  prerelease: boolean;
  draft: boolean;
  assets?: GitHubReleaseApiAsset[];
};

/** Parameters for auto-update check via electron-updater */
interface AutoUpdateCheckParams {
  /** Whether to include prerelease/dev builds in update check */
  includePrerelease?: boolean;
}

const DEFAULT_REPO = 'bitboom/thor';
const DEFAULT_USER_AGENT = 'Thor';
const ALLOWED_ASSET_EXTS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);
const CDN_HOST = 'github.com';
const CDN_BASE_URL = `https://${CDN_HOST}/${DEFAULT_REPO}/releases/latest/download`;

const isAllowedAssetName = (name: string) => {
  const ext = path.extname(name);
  return ALLOWED_ASSET_EXTS.has(ext);
};

const normalizeTagToSemver = (tag: string): string | null => {
  const trimmed = tag.trim();
  const withoutV = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  // Ensure it looks like a semver prefix at least.
  if (!/^\d+\.\d+\.\d+/.test(withoutV)) return null;
  return semver.valid(withoutV);
};

/**
 * Rewrite a GitHub release asset URL to the CDN URL for faster download.
 * The CDN path follows the fixed convention `{base}/{version}/{original-filename}`,
 * matching electron-builder's artifactName output, so no name conversion is needed.
 */
const rewriteAssetUrlToCDN = (assetName: string, version: string): string => {
  return `https://github.com/${DEFAULT_REPO}/releases/download/v${version}/${encodeURIComponent(assetName)}`;
};

type RuntimePlatformInfo = {
  platform: NodeJS.Platform;
  arch: string;
};

type CanonicalArch = 'x64' | 'arm64' | 'ia32';

const normalizeArch = (arch: string): CanonicalArch => {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'ia32' || arch === 'x32') return 'ia32';
  return 'x64';
};

const detectAssetArchs = (nameLower: string): Set<CanonicalArch> => {
  const detected = new Set<CanonicalArch>();

  if (/\b(arm64|aarch64)\b/.test(nameLower)) detected.add('arm64');
  if (/\b(x64|x86_64|amd64)\b/.test(nameLower)) detected.add('x64');

  const hasX86Token = /\bx86\b/.test(nameLower) && !/\bx86[_-]?64\b/.test(nameLower);
  if (/\b(ia32|x32|32bit)\b/.test(nameLower) || hasX86Token) detected.add('ia32');

  return detected;
};

const getPlatformHints = (runtime: RuntimePlatformInfo = { platform: process.platform, arch: process.arch }) => {
  const platform = runtime.platform;
  const arch = runtime.arch;
  const normalizedArch = normalizeArch(arch);

  const archHints =
    normalizedArch === 'arm64'
      ? ['arm64', 'aarch64']
      : normalizedArch === 'ia32'
        ? ['ia32', 'x86', 'x32', '32bit']
        : ['x64', 'x86_64', 'amd64'];

  // electron-builder artifact names often include one of these
  const platformHints =
    platform === 'win32' ? ['win', 'win32', 'windows'] : platform === 'darwin' ? ['mac', 'darwin', 'osx'] : ['linux'];

  return { platform, arch, normalizedArch, archHints, platformHints };
};

const scoreAsset = (asset: GitHubReleaseAsset, runtime?: RuntimePlatformInfo): number => {
  const { platform, normalizedArch, archHints, platformHints } = getPlatformHints(runtime);
  const nameLower = asset.name.toLowerCase();
  const ext = path.extname(asset.name);

  const detectedArchs = detectAssetArchs(nameLower);
  if (detectedArchs.size > 0 && !detectedArchs.has(normalizedArch)) {
    return -1;
  }

  let score = 0;

  // Platform match
  if (platformHints.some((hint) => nameLower.includes(hint))) score += 20;

  // Arch match
  if (archHints.some((hint) => nameLower.includes(hint))) score += 10;
  if (detectedArchs.has(normalizedArch)) score += 15;

  // Prefer installer formats per platform
  if (platform === 'win32') {
    if (ext === '.exe') score += 100;
    if (ext === '.msi') score += 90;
    if (ext === '.zip') score += 50;
  } else if (platform === 'darwin') {
    if (ext === '.dmg') score += 100;
    if (ext === '.zip') score += 70;
  } else {
    if (ext === '.deb') score += 100;
    if (ext === '.rpm') score += 80;
    if (ext === '.zip') score += 40;
  }

  return score;
};

export const pickRecommendedAsset = (
  assets: GitHubReleaseAsset[],
  runtime?: RuntimePlatformInfo
): GitHubReleaseAsset | undefined => {
  if (!assets.length) return undefined;

  const scored = assets
    .map((asset) => ({ asset, score: scoreAsset(asset, runtime) }))
    .filter((item) => item.score >= 0)
    .toSorted((a, b) => b.score - a.score);

  return scored[0]?.asset;
};

export type CdnManifestFile = { url: string; size?: number };
export type CdnLatestManifest = { version: string; files: CdnManifestFile[]; releaseDate?: string };

/**
 * Pick the electron-builder channel file for the current platform/arch,
 * matching the names build-and-release uploads to the CDN root.
 */
export const resolveCdnChannelFile = (
  runtime: RuntimePlatformInfo = { platform: process.platform, arch: process.arch }
): string => {
  const isArm64 = normalizeArch(runtime.arch) === 'arm64';
  if (runtime.platform === 'win32') return isArm64 ? 'latest-win-arm64.yml' : 'latest.yml';
  if (runtime.platform === 'darwin') return isArm64 ? 'latest-arm64-mac.yml' : 'latest-mac.yml';
  return isArm64 ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
};

/** Parse an electron-builder channel yml; null when the shape is unusable. */
export const parseCdnManifest = (raw: string): CdnLatestManifest | null => {
  let doc: unknown;
  try {
    doc = loadYaml(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const { version, files, releaseDate } = doc as Record<string, unknown>;
  if (typeof version !== 'string' || !Array.isArray(files)) return null;
  const mappedFiles = files
    .filter((file): file is Record<string, unknown> => Boolean(file) && typeof file === 'object')
    .filter((file) => typeof file.url === 'string')
    .map((file) => ({ url: file.url as string, size: typeof file.size === 'number' ? file.size : undefined }));
  if (!mappedFiles.length) return null;
  return {
    version,
    files: mappedFiles,
    releaseDate: typeof releaseDate === 'string' ? releaseDate : undefined,
  };
};

/**
 * Build an UpdateReleaseInfo from the CDN manifest alone. `htmlUrl`/`body`
 * stay empty here — the GitHub best-effort enrichment fills them when
 * reachable. fallbackUrl follows GitHub's fixed release-asset URL scheme, so
 * no API call is needed to construct it.
 */
export const mapCdnManifestToRelease = (manifest: CdnLatestManifest, repo: string): UpdateReleaseInfo | null => {
  const version = semver.valid(manifest.version);
  if (!version) return null;
  const assets: GitHubReleaseAsset[] = [];
  for (const file of manifest.files) {
    const name = path.basename(file.url.trim());
    if (!name || !isAllowedAssetName(name)) continue;
    assets.push({
      name,
      url: rewriteAssetUrlToCDN(name, version),
      fallbackUrl: `https://github.com/${repo}/releases/download/v${version}/${name}`,
      size: file.size ?? 0,
    });
  }
  return {
    tagName: `v${version}`,
    version,
    htmlUrl: '',
    publishedAt: manifest.releaseDate,
    prerelease: false,
    draft: false,
    assets,
    recommendedAsset: pickRecommendedAsset(assets),
  };
};

const resolveRepo = (requestRepo?: string): string => {
  if (requestRepo && requestRepo !== DEFAULT_REPO) throw new Error('Thor updates must use bitboom/thor.');
  return DEFAULT_REPO;
};

const fetchGitHubReleases = async (repo: string, timeoutMs = 30000): Promise<GitHubReleaseApi[]> => {
  const url = `https://api.github.com/repos/${repo}/releases`;

  // 添加超时控制，防止网络问题导致无限等待 / Add timeout to prevent infinite wait on network issues
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error((await getI18n()).t('update.errors.githubApiFailed', { status: res.status }));
    }

    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      throw new Error((await getI18n()).t('update.errors.githubApiNotArray'));
    }
    return json as GitHubReleaseApi[];
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error((await getI18n()).t('update.errors.githubApiTimeout'), { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

const CDN_MANIFEST_TIMEOUT_MS = 15000;
const GITHUB_NOTES_TIMEOUT_MS = 10000;

/**
 * Fetch and parse the authoritative CDN channel manifest for the current
 * platform/arch. Any failure here fails the manual check — the CDN is the
 * single source of truth for "is there an update".
 */
const fetchCdnManifest = async (): Promise<CdnLatestManifest> => {
  const url = `${CDN_BASE_URL}/${resolveCdnChannelFile()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CDN_MANIFEST_TIMEOUT_MS);

  log.info('[manual-update] Checking CDN manifest:', url);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error((await getI18n()).t('update.errors.cdnManifestFailed', { status: res.status }));
    }
    const manifest = parseCdnManifest(await res.text());
    if (!manifest) {
      throw new Error((await getI18n()).t('update.errors.cdnManifestInvalid'));
    }
    log.info('[manual-update] CDN manifest resolved:', {
      url,
      version: manifest.version,
      files: manifest.files.length,
    });
    return manifest;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error((await getI18n()).t('update.errors.cdnManifestTimeout'), { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

type ReleaseNotesEnrichment = { body?: string; htmlUrl?: string; name?: string; publishedAt?: string };

/**
 * Best-effort GitHub lookup for the release matching the CDN version. The
 * manual check must work without GitHub (the repo stays the changelog source
 * but may be unreachable), so every failure path resolves to an empty object.
 */
const fetchReleaseNotesEnrichment = async (repo: string, version: string): Promise<ReleaseNotesEnrichment> => {
  try {
    const releases = await fetchGitHubReleases(repo, GITHUB_NOTES_TIMEOUT_MS);
    const match = releases.find((rel) => rel && !rel.draft && normalizeTagToSemver(rel.tag_name) === version);
    if (!match) return {};
    return {
      body: match.body,
      htmlUrl: match.html_url,
      name: match.name,
      publishedAt: match.published_at,
    };
  } catch {
    return {};
  }
};

export function createAutoUpdateStatusBroadcast(): (
  status: import('../services/autoUpdaterService').AutoUpdateStatus
) => void {
  return (status) => ipcBridge.autoUpdate.status.emit(status);
}

export function initUpdateBridge(): void {
  ipcBridge.update.consumeInstallerLastFailure.provider(
    async (): Promise<{ success: boolean; data: InstallerLastFailureMarker | null; msg?: string }> => {
      try {
        return {
          success: true,
          data: await consumeInstallerLastFailure({ appDataDir: app.getPath('appData') }),
        };
      } catch (err: unknown) {
        return { success: false, data: null, msg: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcBridge.update.check.provider(
    async (params): Promise<{ success: boolean; data?: UpdateCheckResult; msg?: string }> => {
      try {
        const repo = resolveRepo(params?.repo);
        const currentVersion = app.getVersion();

        // EN: Versioning note
        // Update comparisons are pure semver: `app.getVersion()` (packaged app version) vs the CDN
        // manifest `version`. If you want dev/prerelease updates to work reliably, CI must inject a
        // prerelease semver into `package.json#version` for dev builds (e.g. `1.7.2-dev.1234+sha.abcdef0`)
        // so semver ordering holds.
        //
        // 中文：版本号说明
        // 更新比较严格使用 semver：`app.getVersion()`（应用自身版本号）对比 CDN manifest 的 `version`。
        // 若要 dev/预发布版本更新可靠生效，需要 CI 在 dev 构建时把 `package.json#version`
        // 注入为带 prerelease 的 semver（如 `1.7.2-dev.1234+sha.abcdef0`），以保证比较顺序正确。

        // The CDN channel manifest is the authoritative source. It serves a single
        // stable channel, so `includePrerelease` no longer affects detection.
        const manifest = await fetchCdnManifest();
        const latest = mapCdnManifestToRelease(manifest, repo);

        const currentSemver = semver.valid(currentVersion) || semver.coerce(currentVersion)?.version;
        if (!currentSemver || !latest) {
          return { success: true, data: { currentVersion, updateAvailable: false } };
        }

        // GitHub only enriches the result with release notes; it never blocks.
        const enrichment = await fetchReleaseNotesEnrichment(repo, latest.version);

        return {
          success: true,
          data: {
            currentVersion,
            updateAvailable: semver.gt(latest.version, currentSemver),
            latest: {
              ...latest,
              body: enrichment.body,
              name: enrichment.name,
              htmlUrl: enrichment.htmlUrl ?? '',
              publishedAt: enrichment.publishedAt ?? latest.publishedAt,
            },
          },
        };
      } catch (err: unknown) {
        return { success: false, msg: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // The manual executable path does not verify integrity. The verified updater
  // and the external release page are the only supported update routes.
  ipcBridge.update.download.provider(async () => ({
    success: false,
    msg: 'Use the verified updater or the Thor releases page.',
  }));
  ipcBridge.update.cancelDownload.provider(async () => ({ success: true }));

  // Auto-updater IPC handlers (electron-updater)
  ipcBridge.autoUpdate.check.provider(
    async (
      params: AutoUpdateCheckParams
    ): Promise<{
      success: boolean;
      data?: { updateInfo?: { version: string; releaseDate?: string; releaseNotes?: string } };
      msg?: string;
    }> => {
      try {
        // Set prerelease preference before checking
        const includePrerelease = Boolean(params?.includePrerelease);
        autoUpdaterService.setAllowPrerelease(includePrerelease);

        const result = await autoUpdaterService.checkForUpdates();
        if (result.success && result.updateInfo) {
          // autoUpdaterService.checkForUpdates() only returns updateInfo when
          // electron-updater confirms isUpdateAvailable, so we can trust it directly.
          return {
            success: true,
            data: {
              updateInfo: {
                version: result.updateInfo.version,
                releaseDate: result.updateInfo.releaseDate,
                releaseNotes:
                  typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined,
              },
            },
          };
        }
        return { success: result.success, msg: result.error };
      } catch (err: unknown) {
        return { success: false, msg: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcBridge.autoUpdate.download.provider(async (): Promise<{ success: boolean; msg?: string }> => {
    try {
      const result = await autoUpdaterService.downloadUpdate();
      return { success: result.success, msg: result.error };
    } catch (err: unknown) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.autoUpdate.restoreDownloaded.provider(
    async (): Promise<{ success: boolean; data: AutoUpdateReadyResult; msg?: string }> => {
      try {
        const result = await autoUpdaterService.restoreDownloadedUpdateIfAvailable();
        return { success: result.success, data: result.data, msg: result.error };
      } catch (err: unknown) {
        return {
          success: false,
          data: { ready: false },
          msg: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcBridge.autoUpdate.cancelDownload.provider(async (): Promise<{ success: boolean; msg?: string }> => {
    try {
      const result = await autoUpdaterService.cancelDownload();
      return { success: result.success, msg: result.error };
    } catch (err: unknown) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.autoUpdate.quitAndInstall.provider(async (): Promise<void> => {
    await autoUpdaterService.quitAndInstall();
  });
}
