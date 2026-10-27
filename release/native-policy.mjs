export const nativeDesktopPolicy = 'thor-electron-native-v1';
// This policy is deliberately reviewed together with the pinned Electron
// runtime. A future Electron upgrade must update and exercise the ABI gate.
export const nativeDesktopElectron = '43.8.3';
export const nativeDesktopAbi = '148';
export const sqliteNativeFile = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

export function validateNativeDesktopProof(value, electronVersion, { packaged = true } = {}) {
  if (!value || value.schemaVersion !== 1 || value.policy !== nativeDesktopPolicy || electronVersion !== nativeDesktopElectron || value.electronVersion !== electronVersion || value.modulesAbi !== nativeDesktopAbi || value.platform !== 'win32' || value.architecture !== 'x64' || value.installedSmoke !== true || (packaged && value.packagedSmoke !== true)) throw new Error('Release requires the current Electron native ABI smoke proof.');
  if (value.sqlite?.name !== 'better-sqlite3' || !/^\d+\.\d+\.\d+$/.test(value.sqlite.version || '') || value.sqlite.file !== sqliteNativeFile || !/^[a-f0-9]{64}$/.test(value.sqlite.sha256 || '') || value.sqlite.persistence !== true) throw new Error('SQLite native ABI or persistence evidence is incomplete.');
  if (value.rebuild?.name !== '@electron/rebuild' || !/^\d+\.\d+\.\d+$/.test(value.rebuild.version || '') || value.rebuild.sourceBuild !== true || value.rebuild.runtimeAbiVerified !== true) throw new Error('Missing locked Electron rebuild provenance.');
  if (packaged && (!Array.isArray(value.additionalNativeFiles) || value.additionalNativeFiles.some(file => !/^node_modules\/[A-Za-z0-9_.@\-/]+\.node$/.test(file.file || '') || file.file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || file.loaded !== true))) throw new Error('Packaged native module load evidence is incomplete.');
  return value;
}
