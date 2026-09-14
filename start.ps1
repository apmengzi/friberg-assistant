$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $projectRoot

if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 -m http.server 4173 --bind 127.0.0.1
  exit $LASTEXITCODE
}

if (Get-Command python -ErrorAction SilentlyContinue) {
  & python -m http.server 4173 --bind 127.0.0.1
  exit $LASTEXITCODE
}

throw '没有找到 Python。请安装 Python 3 后再运行 start.bat。'
