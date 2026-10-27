# SPDX-License-Identifier: Apache-2.0
# Compatible with upstream harness arguments. Thor keeps installer reports local.
param(
  [string]$Dsn,
  [string]$LogPath,
  [string]$Code,
  [string]$Detail,
  [string]$Release,
  [string]$Arch,
  [string]$Session,
  [string]$Updated,
  [switch]$NoUi
)

$ErrorActionPreference = 'Stop'
$thorStatusPath = Join-Path $env:TEMP 'thor-installer-report.json'
$thorStatus = [ordered]@{
  schemaVersion = 1
  status = 'skipped'
  reason = 'privacy-disabled'
  code = $(if ($Code -match '^E[0-9]{4}$') { $Code } else { 'unknown' })
}
[IO.File]::WriteAllText($thorStatusPath, ($thorStatus | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
exit 0
