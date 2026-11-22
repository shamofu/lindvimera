$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

if (!$env:RELEASE_VERSION -or $env:RELEASE_VERSION -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw 'Invalid or missing RELEASE_VERSION.'
}
$taskRoot = if ($env:GITHUB_WORKSPACE) {
  [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
} else {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
}
$taskDistribution = Join-Path $taskRoot 'dist'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskDistribution 'manifest.json') -Raw | ConvertFrom-Json
if ($taskManifest.version -cne $env:RELEASE_VERSION -or $taskManifest.id -cne 'lindvimera') {
  throw 'Distribution manifest differs from the release.'
}
$taskRelease = Join-Path $taskRoot '.release'
if ((Test-Path -LiteralPath $taskRelease) -and @(Get-ChildItem -LiteralPath $taskRelease -Force).Count -gt 0) {
  throw 'Release output must be empty before packaging.'
}
$taskTemporaryRoot = if ($env:RUNNER_TEMP) { [IO.Path]::GetFullPath($env:RUNNER_TEMP) } else { [IO.Path]::GetTempPath() }
$taskStaging = [IO.Path]::GetFullPath((Join-Path $taskTemporaryRoot "lindvimera-package-$([guid]::NewGuid())"))
New-Item -ItemType Directory -Force -Path $taskRelease, $taskStaging | Out-Null
try {
  Copy-Item -LiteralPath $taskDistribution -Destination (Join-Path $taskStaging 'lindvimera') -Recurse
  $taskZip = "lindvimera-$env:RELEASE_VERSION.zip"
  Compress-Archive -LiteralPath (Join-Path $taskStaging 'lindvimera') -DestinationPath (Join-Path $taskRelease $taskZip)
  foreach ($taskName in @('main.js', 'manifest.json', 'styles.css')) {
    Copy-Item -LiteralPath (Join-Path $taskDistribution $taskName) -Destination (Join-Path $taskRelease $taskName)
  }
  $taskSums = foreach ($taskName in @('main.js', 'manifest.json', 'styles.css', $taskZip)) {
    $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskRelease $taskName) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$taskHash  $taskName"
  }
  [IO.File]::WriteAllText((Join-Path $taskRelease 'SHA256SUMS'), (($taskSums -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Host "Packaged release $env:RELEASE_VERSION."
} finally {
  Remove-Item -LiteralPath $taskStaging -Recurse -Force
}
