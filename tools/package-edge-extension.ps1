$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceExtension = Join-Path $ProjectRoot 'extension'
$OutputExtension = Join-Path $ProjectRoot 'dist\friberg-assistant-extension'
$OutputZip = Join-Path $ProjectRoot 'dist\friberg-assistant-extension.zip'
$TemporaryZip = Join-Path $ProjectRoot 'dist\friberg-assistant-extension.next.zip'

# These files are the shared, audited core. Keep the source extension in sync
# before copying it into the user-loadable dist directory.
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'solver.js') -Destination (Join-Path $SourceExtension 'solver.js') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'automation-core.js') -Destination (Join-Path $SourceExtension 'automation-core.js') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'live-dom-adapter.js') -Destination (Join-Path $SourceExtension 'live-dom-adapter.js') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data\players.game-646.json') -Destination (Join-Path $SourceExtension 'data\game-players-646.json') -Force

if (Test-Path -LiteralPath $OutputExtension) {
  Remove-Item -LiteralPath $OutputExtension -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputExtension -Force | Out-Null
Copy-Item -Path (Join-Path $SourceExtension '*') -Destination $OutputExtension -Recurse -Force

if (-not (Test-Path -LiteralPath (Join-Path $OutputExtension 'manifest.json'))) {
  throw 'Packaging failed: manifest.json is not at the root of the loadable extension folder.'
}

Remove-Item -LiteralPath $TemporaryZip -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $OutputExtension -Force | Select-Object -ExpandProperty FullName) -DestinationPath $TemporaryZip -Force
Move-Item -LiteralPath $TemporaryZip -Destination $OutputZip -Force

[pscustomobject]@{
  extensionDirectory = $OutputExtension
  zip = $OutputZip
  manifestAtRoot = Test-Path -LiteralPath (Join-Path $OutputExtension 'manifest.json')
  status = 'packaged'
} | ConvertTo-Json -Compress
