param(
  [Parameter(Mandatory = $true)]
  [string]$PrivateKey,
  [Parameter(Mandatory = $true)]
  [string]$DeviceCode,
  [Parameter(Mandatory = $true)]
  [string]$LicenseId,
  [double]$Days = 0,
  [double]$Hours = 0,
  [string]$MinVersion = '0.9.2',
  [string]$MaxVersion = '',
  [string]$Note = '',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'generate-license.mjs'
$arguments = @(
  $script,
  '--private-key', $PrivateKey,
  '--device-code', $DeviceCode,
  '--license-id', $LicenseId,
  '--days', [string]$Days,
  '--hours', [string]$Hours,
  '--min-version', $MinVersion
)
if ($MaxVersion) { $arguments += @('--max-version', $MaxVersion) }
if ($Note) { $arguments += @('--note', $Note) }
if ($Out) { $arguments += @('--out', $Out) }

node @arguments
if ($LASTEXITCODE -ne 0) { throw "许可证生成失败，退出码：$LASTEXITCODE" }

