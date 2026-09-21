$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

foreach ($taskVariable in @('RELEASE_VERSION', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')) {
  if (![Environment]::GetEnvironmentVariable($taskVariable)) { throw "Missing environment variable: $taskVariable" }
}
if ($env:RELEASE_VERSION -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid release version.' }
if ($env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$') { throw 'Invalid source commit.' }
if ($env:GITHUB_RUN_ID -cnotmatch '^[1-9]\d*$') { throw 'Invalid run ID.' }
$taskAttempt = 0
if (![int]::TryParse($env:GITHUB_RUN_ATTEMPT, [ref]$taskAttempt) -or $taskAttempt -lt 1) { throw 'Invalid run attempt.' }
$taskRoot = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$taskDistribution = Join-Path $taskRoot 'dist'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskDistribution 'manifest.json') -Raw | ConvertFrom-Json
if ($taskManifest.version -cne $env:RELEASE_VERSION -or $taskManifest.id -cne 'lindvimera') { throw 'Distribution manifest differs from the release.' }
$taskRelease = Join-Path $taskRoot '.release'
$taskGate = Join-Path $taskRoot '.release-gate'
if ((Test-Path -LiteralPath $taskRelease) -and @(Get-ChildItem -LiteralPath $taskRelease -Force).Count -gt 0) {
  throw 'Release output must be empty before packaging.'
}
$taskTemporaryRoot = if ($env:RUNNER_TEMP) { [IO.Path]::GetFullPath($env:RUNNER_TEMP) } else { [IO.Path]::GetTempPath() }
$taskStaging = [IO.Path]::GetFullPath((Join-Path $taskTemporaryRoot "lindvimera-package-$([guid]::NewGuid())"))
New-Item -ItemType Directory -Force -Path $taskRelease, $taskGate, $taskStaging | Out-Null
try {
  Copy-Item -LiteralPath $taskDistribution -Destination (Join-Path $taskStaging 'lindvimera') -Recurse
  $taskZip = "lindvimera-$env:RELEASE_VERSION.zip"
  Compress-Archive -LiteralPath (Join-Path $taskStaging 'lindvimera') -DestinationPath (Join-Path $taskRelease $taskZip)
  foreach ($taskName in @('main.js', 'manifest.json', 'styles.css')) {
    Copy-Item -LiteralPath (Join-Path $taskDistribution $taskName) -Destination (Join-Path $taskRelease $taskName)
  }
  $taskHashes = [ordered]@{}
  $taskSums = foreach ($taskName in @('main.js', 'manifest.json', 'styles.css', $taskZip)) {
    $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskRelease $taskName) -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskHashes[$taskName] = $taskHash
    "$taskHash  $taskName"
  }
  $taskSumsPath = Join-Path $taskRelease 'SHA256SUMS'
  [IO.File]::WriteAllText($taskSumsPath, (($taskSums -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  $taskHashes['SHA256SUMS'] = (Get-FileHash -LiteralPath $taskSumsPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $taskProvenance = [ordered]@{
    schemaVersion = 2
    repository = $env:GITHUB_REPOSITORY
    commit = $env:GITHUB_SHA
    version = $env:RELEASE_VERSION
    runId = [string]$env:GITHUB_RUN_ID
    runAttempt = $taskAttempt
    files = $taskHashes
  }
  $taskProvenancePath = Join-Path $taskRelease 'provenance.json'
  $taskProvenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskProvenancePath -Encoding utf8NoBOM
  $taskHashes['provenance.json'] = (Get-FileHash -LiteralPath $taskProvenancePath -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{
    schemaVersion = 2
    repository = $env:GITHUB_REPOSITORY
    commit = $env:GITHUB_SHA
    version = $env:RELEASE_VERSION
    runId = [string]$env:GITHUB_RUN_ID
    runAttempt = $taskAttempt
    hashes = $taskHashes
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskGate 'info.json') -Encoding utf8NoBOM
  Write-Host "Packaged release $env:RELEASE_VERSION from $env:GITHUB_SHA."
} finally {
  if ([IO.Path]::GetDirectoryName($taskStaging).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $taskTemporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
    throw 'Packaging staging directory escaped the temporary root.'
  }
  Remove-Item -LiteralPath $taskStaging -Recurse -Force
}
