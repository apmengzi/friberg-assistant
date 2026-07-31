param(
  [string]$ZipPath = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ZipPath) {
  $ZipPath = Join-Path $projectRoot 'dist\friberg-assistant-commercial.zip'
}
$resolvedZip = [System.IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $resolvedZip)) {
  throw "Commercial ZIP does not exist: $resolvedZip"
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$auditDirectory = Join-Path $temporaryRoot ("friberg-commercial-audit-" + [Guid]::NewGuid().ToString('N'))
$resolvedAudit = [System.IO.Path]::GetFullPath($auditDirectory)
if (-not $resolvedAudit.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use unsafe audit directory: $resolvedAudit"
}

New-Item -ItemType Directory -Path $resolvedAudit -Force | Out-Null
try {
  Expand-Archive -LiteralPath $resolvedZip -DestinationPath $resolvedAudit -Force
  $failures = [System.Collections.Generic.List[string]]::new()
  $manifestPath = Join-Path $resolvedAudit 'manifest.json'
  $requiredFiles = @(
    'manifest.json',
    'license-config.js',
    'license-core.js',
    'license-client.js',
    'PUBLIC_LICENSE_KEY.pem',
    'data\game-players-646.json',
    'FILE_MANIFEST.txt',
    'SHA256SUMS.txt'
  )
  foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedAudit $relative))) {
      $failures.Add("Missing required file: $relative")
    }
  }

  $allFiles = Get-ChildItem -LiteralPath $resolvedAudit -File -Recurse
  foreach ($file in $allFiles) {
    $relative = $file.FullName.Substring($resolvedAudit.Length + 1)
    if ($file.Name -match 'private.*key|\.env(?:\.|$)|\.map$' -or
        $relative -match 'seller-tools|license-generator|scriptcat|friberg-assistant-personal') {
      $failures.Add("Forbidden file: $relative")
    }
    if ($file.Length -le 5MB) {
      $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
      if ($text -match '127\.0\.0\.1|localhost|ADMIN_TOKEN|LICENSE_PEPPER|BEGIN PRIVATE KEY|FRIBERG_LICENSE_ADMIN') {
        $failures.Add("Forbidden content in: $relative")
      }
      if ($text -match 'C:\\Users\\|/Users/|/home/') {
        $failures.Add("Local absolute path in: $relative")
      }
    }
  }

  if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3) { $failures.Add('manifest_version must be 3') }
    if (@($manifest.permissions) -join ',' -ne 'storage') { $failures.Add('Commercial permissions must contain only storage') }
    if ($manifest.PSObject.Properties.Name -contains 'optional_host_permissions') { $failures.Add('optional_host_permissions must be absent') }
    $hosts = @($manifest.host_permissions) + @($manifest.content_scripts.matches)
    foreach ($hostPattern in $hosts) {
      if ($hostPattern -notlike 'https://shnlfriberg.online/multi*') {
        $failures.Add("Unexpected host permission: $hostPattern")
      }
    }
  }

  if ($failures.Count) {
    throw ("Commercial ZIP audit failed:`n- " + ($failures -join "`n- "))
  }

  $zipHash = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $auditDoc = Join-Path $projectRoot 'docs\COMMERCIAL_BUILD_AUDIT.md'
  @"
# Commercial Build Audit

- Build: 0.9.2 Paid Beta
- ZIP: `$resolvedZip`
- SHA-256: `$zipHash`
- manifest.json at ZIP root: passed
- 646-player dataset present: passed
- Ed25519 public key present: passed
- private key absent: passed
- seller tools absent: passed
- localhost and 127.0.0.1 absent: passed
- administrator secrets absent: passed
- source maps and .env files absent: passed
- ScriptCat and personal edition absent: passed
- host permissions limited to shnlfriberg.online/multi*: passed

This audit verifies package composition. It does not claim that a browser extension
or an offline time-limited license is impossible to modify.
"@ | Set-Content -LiteralPath $auditDoc -Encoding UTF8

  [pscustomobject]@{
    zip = $resolvedZip
    sha256 = $zipHash
    checks = 13
    failures = 0
    report = $auditDoc
    status = 'passed'
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $resolvedAudit) {
    Remove-Item -LiteralPath $resolvedAudit -Recurse -Force
  }
}
