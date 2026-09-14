param(
  [Parameter(Mandatory = $true)]
  [string]$PublicKeyPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceExtension = Join-Path $projectRoot 'extension'
$overlaySource = Join-Path $projectRoot 'commercial\extension-overlay'
$licenseCoreSource = Join-Path $projectRoot 'commercial\offline-license\license-core.js'
$distRoot = Join-Path $projectRoot 'dist'
$outputExtension = Join-Path $distRoot 'friberg-assistant-commercial'
$outputZip = Join-Path $distRoot 'friberg-assistant-commercial.zip'
$temporaryZip = Join-Path $distRoot 'friberg-assistant-commercial.next.zip'
$resolvedPublicKey = [System.IO.Path]::GetFullPath($PublicKeyPath)

if (-not (Test-Path -LiteralPath $resolvedPublicKey)) {
  throw "Public key does not exist: $resolvedPublicKey"
}

$resolvedDist = [System.IO.Path]::GetFullPath($distRoot)
$resolvedOutput = [System.IO.Path]::GetFullPath($outputExtension)
if (-not $resolvedOutput.StartsWith($resolvedDist + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside the dist directory: $resolvedOutput"
}

$publicPem = Get-Content -LiteralPath $resolvedPublicKey -Raw -Encoding UTF8
$publicBase64 = ($publicPem -replace '-----BEGIN PUBLIC KEY-----', '' -replace '-----END PUBLIC KEY-----', '' -replace '\s+', '')
try {
  $publicDer = [Convert]::FromBase64String($publicBase64)
} catch {
  throw 'PublicKeyPath must contain an Ed25519 SPKI PEM public key.'
}
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $keyHash = $sha.ComputeHash($publicDer)
} finally {
  $sha.Dispose()
}
$keyId = ([BitConverter]::ToString($keyHash) -replace '-', '').ToLowerInvariant().Substring(0, 16)

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $outputExtension) {
  Remove-Item -LiteralPath $outputExtension -Recurse -Force
}
New-Item -ItemType Directory -Path $outputExtension -Force | Out-Null
Copy-Item -Path (Join-Path $sourceExtension '*') -Destination $outputExtension -Recurse -Force

Copy-Item -LiteralPath (Join-Path $projectRoot 'solver.js') -Destination (Join-Path $outputExtension 'solver.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'automation-core.js') -Destination (Join-Path $outputExtension 'automation-core.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'live-dom-adapter.js') -Destination (Join-Path $outputExtension 'live-dom-adapter.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'data\players.game-646.json') -Destination (Join-Path $outputExtension 'data\game-players-646.json') -Force
Copy-Item -LiteralPath $licenseCoreSource -Destination (Join-Path $outputExtension 'license-core.js') -Force
Copy-Item -LiteralPath (Join-Path $overlaySource 'license-client.js') -Destination (Join-Path $outputExtension 'license-client.js') -Force
Copy-Item -LiteralPath (Join-Path $overlaySource 'license-background.js') -Destination (Join-Path $outputExtension 'background.js') -Force
Copy-Item -LiteralPath $resolvedPublicKey -Destination (Join-Path $outputExtension 'PUBLIC_LICENSE_KEY.pem') -Force

# The commercial build is intentionally limited to the public game origin.
$commercialAutomationPath = Join-Path $outputExtension 'automation-core.js'
$commercialAutomation = Get-Content -LiteralPath $commercialAutomationPath -Raw -Encoding UTF8
$commercialAutomation = $commercialAutomation.Replace("new Set(['localhost', '127.0.0.1', '[::1]'])", 'new Set([])')
$commercialAutomation | Set-Content -LiteralPath $commercialAutomationPath -Encoding UTF8 -NoNewline

$commercialContentPath = Join-Path $outputExtension 'content-script.js'
$commercialContent = Get-Content -LiteralPath $commercialContentPath -Raw -Encoding UTF8
$commercialContent = $commercialContent -replace "const isLocalLiveFixture = \(\) => location\.hostname === '127\.0\.0\.1'\s*&& document\.documentElement\.dataset\.fribergLiveFixture === 'true';", 'const isLocalLiveFixture = () => false;'
$commercialContent | Set-Content -LiteralPath $commercialContentPath -Encoding UTF8 -NoNewline

$configTemplate = Get-Content -LiteralPath (Join-Path $overlaySource 'license-config.template.js') -Raw -Encoding UTF8
$configText = $configTemplate.Replace('__PUBLIC_KEY_ID__', $keyId).Replace('__PUBLIC_KEY_SPKI_BASE64__', $publicBase64)
$configText | Set-Content -LiteralPath (Join-Path $outputExtension 'license-config.js') -Encoding UTF8 -NoNewline

$manifestPath = Join-Path $outputExtension 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.name = 'Friberg Assistant Pro - Offline Licensed Edition'
$manifest.version = '0.9.2'
$manifest.description = 'Paid Beta with offline Ed25519 device licensing, strict solving, visible feedback, fill, and user-triggered submit.'
$manifest.permissions = @('storage')
$manifest.host_permissions = @('https://shnlfriberg.online/multi*')
$manifest.PSObject.Properties.Remove('optional_host_permissions')
$manifest.PSObject.Properties.Remove('options_page')
$manifest.content_scripts[0].matches = @('https://shnlfriberg.online/multi*')
$manifest.content_scripts[0].js = @(
  'license-config.js',
  'license-core.js',
  'solver.js',
  'automation-core.js',
  'live-dom-adapter.js',
  'overlay.js',
  'license-client.js',
  'content-script.js'
)
$manifest.web_accessible_resources[0].matches = @('https://shnlfriberg.online/multi*')
$manifest.background.service_worker = 'background.js'
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$notice = @'
Friberg Assistant Pro 0.9.2 Paid Beta

This package contains the 646-player dataset from:
https://github.com/shnlfriberg/csgo-major-db
The dataset repository is licensed under the MIT License.

The public game repository is:
https://github.com/shnlfriberg/csgofriberg
It is licensed under AGPL-3.0. This assistant is distributed with its human-readable
extension source files; no warranty is provided.

The embedded Ed25519 public key verifies licenses only. It cannot generate licenses.
'@
$notice | Set-Content -LiteralPath (Join-Path $outputExtension 'THIRD_PARTY_NOTICE.txt') -Encoding UTF8

$allFiles = Get-ChildItem -LiteralPath $outputExtension -File -Recurse | Sort-Object FullName
$relativeFiles = $allFiles | ForEach-Object {
  $_.FullName.Substring($resolvedOutput.Length + 1).Replace('\', '/')
}
$relativeFiles | Set-Content -LiteralPath (Join-Path $outputExtension 'FILE_MANIFEST.txt') -Encoding UTF8

$hashLines = Get-ChildItem -LiteralPath $outputExtension -File -Recurse |
  Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
  Sort-Object FullName |
  ForEach-Object {
    $relative = $_.FullName.Substring($resolvedOutput.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relative"
  }
$hashLines | Set-Content -LiteralPath (Join-Path $outputExtension 'SHA256SUMS.txt') -Encoding ascii

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'Packaging failed: manifest.json is not at the root of the commercial extension folder.'
}

Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
Compress-Archive `
  -LiteralPath (Get-ChildItem -LiteralPath $outputExtension -Force | Select-Object -ExpandProperty FullName) `
  -DestinationPath $temporaryZip `
  -Force
Move-Item -LiteralPath $temporaryZip -Destination $outputZip -Force

[pscustomobject]@{
  edition = 'commercial-offline'
  version = '0.9.2'
  extensionDirectory = $outputExtension
  zip = $outputZip
  manifestAtRoot = Test-Path -LiteralPath $manifestPath
  keyId = $keyId
  onlineLicenseDependency = $false
  status = 'packaged'
} | ConvertTo-Json -Compress
