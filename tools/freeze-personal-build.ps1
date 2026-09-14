param(
  [string]$Version = '0.9.1',
  [string]$Timestamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'dist\friberg-assistant-extension'
$backupRoot = Join-Path $projectRoot 'artifacts\backups'
$backupDirectory = Join-Path $backupRoot "self-use-$Version-$Timestamp"
$backupZip = "$backupDirectory.zip"
$hashFile = "$backupZip.sha256.txt"

if (-not (Test-Path -LiteralPath (Join-Path $source 'manifest.json'))) {
  throw "Personal extension build is missing or invalid: $source"
}

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
if (Test-Path -LiteralPath $backupDirectory) {
  throw "Backup destination already exists: $backupDirectory"
}

Copy-Item -LiteralPath $source -Destination $backupDirectory -Recurse -Force
Compress-Archive `
  -LiteralPath (Get-ChildItem -LiteralPath $backupDirectory -Force | Select-Object -ExpandProperty FullName) `
  -DestinationPath $backupZip `
  -Force

$hash = (Get-FileHash -LiteralPath $backupZip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([System.IO.Path]::GetFileName($backupZip))" |
  Set-Content -LiteralPath $hashFile -Encoding ascii -NoNewline

[pscustomobject]@{
  version = $Version
  directory = $backupDirectory
  zip = $backupZip
  sha256 = $hash
  hashFile = $hashFile
} | ConvertTo-Json -Compress
