param(
  [Parameter(Mandatory = $true)]
  [string]$KeyDirectory
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'create-signing-key.mjs'
node $script --key-dir $KeyDirectory
if ($LASTEXITCODE -ne 0) { throw "密钥生成失败，退出码：$LASTEXITCODE" }

