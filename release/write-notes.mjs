import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'desktop/aionui/package.json'), 'utf8'));
writeFileSync(path.join(root, 'release-notes.md'), `Thor ${pkg.version} — public Windows preview\n\n` +
  `Download Thor-${pkg.version}-win-x64.exe to install. Updates are designed to retain the Thor user-data directory and external projects; installed acceptance evidence is linked below.\n\n` +
  `This is an unsigned preview build. It does not claim Windows publisher verification. SHA256SUMS.txt and thor-build.json identify the artifact and build.\n\n` +
  `Includes source-built AionCore, the pinned read-only OfficeCLI derivative, project-memory tools, synthetic mail MCP, and reviewed text feedback to bitboom/thor. Direct issue submission uses the bundled GitHub CLI and requires user login. Installer failures remain local. Real corporate mail, DRM, SSO and internal model compatibility are not verified by this public release.\n\n` +
  `See https://github.com/bitboom/thor/blob/v${pkg.version}/docs/verification/ACCEPTANCE.md for verified behavior and outstanding checks.\n`);
