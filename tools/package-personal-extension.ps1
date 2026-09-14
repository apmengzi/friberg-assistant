$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceExtension = Join-Path $projectRoot 'extension'
$distRoot = Join-Path $projectRoot 'dist'
$outputExtension = Join-Path $distRoot 'friberg-assistant-personal'
$outputZip = Join-Path $distRoot 'friberg-assistant-personal.zip'
$temporaryZip = Join-Path $distRoot 'friberg-assistant-personal.next.zip'

Copy-Item -LiteralPath (Join-Path $projectRoot 'solver.js') -Destination (Join-Path $sourceExtension 'solver.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'automation-core.js') -Destination (Join-Path $sourceExtension 'automation-core.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'live-dom-adapter.js') -Destination (Join-Path $sourceExtension 'live-dom-adapter.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'data\players.game-646.json') -Destination (Join-Path $sourceExtension 'data\game-players-646.json') -Force

if (Test-Path -LiteralPath $outputExtension) {
  Remove-Item -LiteralPath $outputExtension -Recurse -Force
}
New-Item -ItemType Directory -Path $outputExtension -Force | Out-Null
Copy-Item -Path (Join-Path $sourceExtension '*') -Destination $outputExtension -Recurse -Force

$manifestPath = Join-Path $outputExtension 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'Packaging failed: manifest.json is not at the root of the personal extension folder.'
}

Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
Compress-Archive `
  -LiteralPath (Get-ChildItem -LiteralPath $outputExtension -Force | Select-Object -ExpandProperty FullName) `
  -DestinationPath $temporaryZip `
  -Force
Move-Item -LiteralPath $temporaryZip -Destination $outputZip -Force

[pscustomobject]@{
  edition = 'personal'
  version = '0.9.3'
  extensionDirectory = $outputExtension
  zip = $outputZip
  manifestAtRoot = $true
  licenseRequired = $false
  status = 'packaged'
} | ConvertTo-Json -Compress
