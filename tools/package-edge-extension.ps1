$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceExtension = Join-Path $ProjectRoot 'extension'
$OutputExtension = Join-Path $ProjectRoot 'dist\friberg-assistant-extension'
$OutputZip = Join-Path $ProjectRoot 'dist\friberg-assistant-extension.zip'
$TemporaryZip = Join-Path $ProjectRoot 'dist\friberg-assistant-extension.next.zip'

if (Test-Path -LiteralPath $OutputExtension) {
  Remove-Item -LiteralPath $OutputExtension -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputExtension -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OutputExtension 'data') -Force | Out-Null

$extensionFiles = @(
  'manifest.json',
  'background.js',
  'ultimate-ui.css',
  'ultimate-policy.js',
  'ultimate-dom.js',
  'ultimate-ui.js',
  'ultimate-controller.js'
)
foreach ($relative in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $SourceExtension $relative) -Destination (Join-Path $OutputExtension $relative) -Force
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'solver.js') -Destination (Join-Path $OutputExtension 'solver.js') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'automation-core.js') -Destination (Join-Path $OutputExtension 'automation-core.js') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'data\players.game-646.json') -Destination (Join-Path $OutputExtension 'data\game-players-646.json') -Force

$expected = @(
  'manifest.json',
  'background.js',
  'solver.js',
  'automation-core.js',
  'ultimate-ui.css',
  'ultimate-policy.js',
  'ultimate-dom.js',
  'ultimate-ui.js',
  'ultimate-controller.js',
  'data\game-players-646.json'
)
foreach ($relative in $expected) {
  if (-not (Test-Path -LiteralPath (Join-Path $OutputExtension $relative))) {
    throw "Packaging failed: missing $relative"
  }
}

Remove-Item -LiteralPath $TemporaryZip -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $OutputExtension -Force | Select-Object -ExpandProperty FullName) -DestinationPath $TemporaryZip -Force
Move-Item -LiteralPath $TemporaryZip -Destination $OutputZip -Force

[pscustomobject]@{
  extensionDirectory = $OutputExtension
  zip = $OutputZip
  manifestAtRoot = Test-Path -LiteralPath (Join-Path $OutputExtension 'manifest.json')
  shippedFiles = $expected.Count
  status = 'packaged'
} | ConvertTo-Json -Compress
