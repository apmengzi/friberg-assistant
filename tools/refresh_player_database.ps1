$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
$target = Join-Path $dataDir 'players.game-646.json'
$temporary = Join-Path $dataDir 'players.game-646.download.json'
$uri = 'https://raw.githubusercontent.com/shnlfriberg/csgo-major-db/main/players.json'
$minimumPlayers = 600

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
try {
  Invoke-WebRequest -Uri $uri -OutFile $temporary -UseBasicParsing
  # Windows PowerShell 5 treats UTF-8 without a BOM as the active ANSI code
  # page. Read bytes explicitly as UTF-8 so Chinese fields remain valid JSON.
  $json = [System.IO.File]::ReadAllText($temporary, [System.Text.Encoding]::UTF8)
  $rows = $json | ConvertFrom-Json
  $count = @($rows).Count
  if ($count -lt $minimumPlayers) {
    throw "Downloaded game pool has only $count records; expected at least $minimumPlayers. Existing local pool was kept."
  }

  Copy-Item -LiteralPath $temporary -Destination $target -Force
  Write-Host ("Saved {0} player records to {1}" -f $count, $target)
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force
  }
}
