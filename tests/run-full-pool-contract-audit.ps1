$ErrorActionPreference = 'Stop'

# Four deterministic shards concatenate to every one of the 646 × 646
# guess/answer combinations while staying below short command time limits.
$ranges = @(
  @(0, 162),
  @(162, 324),
  @(324, 486),
  @(486, 646)
)

foreach ($range in $ranges) {
  & node "$PSScriptRoot\run-full-pool-contract-audit.js" $range[0] $range[1]
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
