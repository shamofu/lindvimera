$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = $env:GITHUB_REPOSITORY
$tag = $env:GITHUB_REF_NAME
$commit = $env:GITHUB_SHA
$runId = $env:GITHUB_RUN_ID
$runAttempt = 0
if (
  $env:GITHUB_REF_TYPE -cne 'tag' -or $tag -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
  !$repo -or $commit -cnotmatch '^[a-f0-9]{40}$' -or $runId -cnotmatch '^[1-9]\d*$' -or
  ![int]::TryParse($env:GITHUB_RUN_ATTEMPT, [ref]$runAttempt) -or $runAttempt -le 0
) { throw 'Publication requires a numeric release tag and the current workflow identity.' }

function Test-Integer($Value) {
  return ($Value -is [int] -or $Value -is [long])
}

function Confirm-BuildIdentity($Value, [string]$Description) {
  if (
    $Value -isnot [System.Collections.IDictionary] -or
    !(Test-Integer $Value.schemaVersion) -or $Value.schemaVersion -ne 2 -or
    $Value.repository -isnot [string] -or $Value.repository -cne $repo -or
    $Value.commit -isnot [string] -or $Value.commit -cne $commit -or
    $Value.version -isnot [string] -or $Value.version -cne $tag -or
    $Value.runId -isnot [string] -or $Value.runId -cne $runId -or
    !(Test-Integer $Value.runAttempt) -or $Value.runAttempt -ne $runAttempt
  ) { throw "$Description does not match this workflow." }
}

$info = Get-Content .release-gate/info.json -Raw | ConvertFrom-Json -AsHashtable -NoEnumerate
Confirm-BuildIdentity $info 'Build metadata'

function Confirm-Tag {
  git fetch --force --no-tags origin '+refs/heads/release:refs/remotes/origin/release' "+refs/tags/${tag}:refs/tags/${tag}"
  if ((git rev-parse "refs/tags/${tag}^{commit}") -cne $commit) { throw 'The release tag moved.' }
  git merge-base --is-ancestor $commit refs/remotes/origin/release
}

Confirm-Tag
$directory = '.release'
$files = @('main.js', 'manifest.json', 'styles.css', "lindvimera-$tag.zip", 'SHA256SUMS', 'provenance.json')
if (
  $info.hashes -isnot [System.Collections.IDictionary] -or
  (Compare-Object (Get-ChildItem $directory -Force).Name $files -CaseSensitive) -or
  (Compare-Object @($info.hashes.Keys) $files -CaseSensitive)
) { throw 'Unexpected release file inventory.' }

$provenance = Get-Content "$directory/provenance.json" -Raw | ConvertFrom-Json -AsHashtable -NoEnumerate
Confirm-BuildIdentity $provenance 'Release provenance'
if (
  $provenance.files -isnot [System.Collections.IDictionary] -or
  (Compare-Object @($provenance.files.Keys) @($files | Where-Object { $_ -ne 'provenance.json' }) -CaseSensitive)
) { throw 'Unexpected provenance inventory.' }
foreach ($file in $files) {
  $hash = (Get-FileHash "$directory/$file" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($info.hashes[$file] -isnot [string] -or $hash -cne $info.hashes[$file]) { throw "Release file changed: $file" }
  if ($file -ne 'provenance.json' -and ($provenance.files[$file] -isnot [string] -or $hash -cne $provenance.files[$file])) {
    throw "Provenance checksum mismatch: $file"
  }
}
$sums = @{}
foreach ($line in Get-Content "$directory/SHA256SUMS") {
  if ($line -cnotmatch '^([a-f0-9]{64})  (.+)$' -or $sums.ContainsKey($Matches[2])) { throw 'Invalid SHA256SUMS.' }
  $sums[$Matches[2]] = $Matches[1]
}
if (Compare-Object @($sums.Keys) @($files | Where-Object { $_ -notin @('SHA256SUMS', 'provenance.json') }) -CaseSensitive) {
  throw 'Incomplete SHA256SUMS.'
}
foreach ($file in $sums.Keys) { if ($sums[$file] -cne $info.hashes[$file]) { throw "SHA256SUMS mismatch: $file" } }
$manifest = Get-Content "$directory/manifest.json" -Raw | ConvertFrom-Json
if (
  $manifest.id -isnot [string] -or $manifest.id -cne 'lindvimera' -or
  $manifest.version -isnot [string] -or $manifest.version -cne $tag
) { throw 'Release manifest differs from the tag.' }
foreach ($file in $files) {
  gh attestation verify "$directory/$file" --repo $repo --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/$tag" --source-digest $commit --deny-self-hosted-runners --limit 1000 | Out-Null
}

$identity = [ordered]@{
  schemaVersion = 2; repository = $repo; commit = $commit; version = $tag
  runId = $runId; runAttempt = $runAttempt; provenance = $info.hashes['provenance.json']
} | ConvertTo-Json -Compress
$marker = "<!-- lindvimera-release:$identity -->"
$notes = ([string](Get-Content .release-gate/notes.md -Raw)).TrimEnd()
if (!$notes -or $notes -match '<!--\s*lindvimera-release:') { throw 'Release notes are empty or contain a publication marker.' }

function Get-Release {
  # Authenticated listing includes drafts, unlike the tag lookup endpoint.
  $pages = gh api "repos/$repo/releases?per_page=100" --paginate --slurp | ConvertFrom-Json
  $matchingReleases = @($pages | ForEach-Object { $_ } | Where-Object tag_name -CEQ $tag)
  if ($matchingReleases.Count -gt 1) { throw 'Multiple releases use this tag.' }
  return $matchingReleases | Select-Object -First 1
}

function Get-ManagedIdentity($Release) {
  if ($Release.body -isnot [string]) { throw 'Existing draft is not a matching managed release.' }
  $starts = [regex]::Matches($Release.body, '<!--\s*lindvimera-release:')
  $markers = [regex]::Matches($Release.body, '<!--\s*lindvimera-release:(.*?)-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($starts.Count -ne 1 -or $markers.Count -ne 1) { throw 'Existing draft must contain exactly one valid publication marker.' }
  try { $value = $markers[0].Groups[1].Value | ConvertFrom-Json -AsHashtable -NoEnumerate } catch { throw 'Existing draft has an invalid publication marker.' }
  if (
    $value -isnot [System.Collections.IDictionary] -or
    !(Test-Integer $value.schemaVersion) -or $value.schemaVersion -ne 2 -or
    $value.repository -isnot [string] -or $value.repository -cne $repo -or
    $value.commit -isnot [string] -or $value.commit -cne $commit -or
    $value.version -isnot [string] -or $value.version -cne $tag -or
    $value.runId -isnot [string] -or $value.runId -cnotmatch '^[1-9]\d*$' -or
    !(Test-Integer $value.runAttempt) -or $value.runAttempt -le 0 -or
    $value.provenance -isnot [string] -or $value.provenance -cnotmatch '^[a-f0-9]{64}$'
  ) { throw 'Existing draft is not a matching managed release.' }
  return $value
}

function Confirm-ManagedDraft($Release, $ExpectedId) {
  if (
    !$Release -or !(Test-Integer $Release.id) -or $Release.id -le 0 -or
    ($null -ne $ExpectedId -and $Release.id -ne $ExpectedId) -or
    $Release.tag_name -isnot [string] -or $Release.tag_name -cne $tag -or
    $Release.draft -isnot [bool]
  ) { throw 'Could not verify the managed draft.' }
  if (!$Release.draft) { throw 'This version is already published and will not be changed. Use a new version.' }
  return Get-ManagedIdentity $Release
}

function Confirm-CurrentDraft($Release, $ExpectedId) {
  $value = Confirm-ManagedDraft $Release $ExpectedId
  if ($value.runId -cne $runId -or $value.runAttempt -ne $runAttempt -or $value.provenance -cne $info.hashes['provenance.json']) {
    throw 'The new draft does not match this build.'
  }
}

function Confirm-Assets($ReleaseId) {
  $pages = gh api "repos/$repo/releases/$ReleaseId/assets?per_page=100" --paginate --slurp | ConvertFrom-Json
  $assets = @($pages | ForEach-Object { $_ })
  $names = @()
  foreach ($asset in $assets) {
    if (
      $asset.name -isnot [string] -or $asset.name -cnotin $files -or $asset.name -cin $names -or
      $asset.state -isnot [string] -or $asset.state -cne 'uploaded'
    ) { throw 'Unexpected or incomplete remote asset.' }
    gh release download $tag --repo $repo --pattern $asset.name --dir .release-gate/remote --clobber | Out-Null
    $remoteHash = (Get-FileHash ".release-gate/remote/$($asset.name)" -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($remoteHash -cne $info.hashes[$asset.name]) { throw "Existing release asset differs: $($asset.name)" }
    $names += $asset.name
  }
  if ($names.Count -ne $files.Count) { throw 'Release assets are incomplete.' }
}

$release = Get-Release
if ($release) { Confirm-ManagedDraft $release $null | Out-Null }
Confirm-Tag
if ($release) {
  # Re-read by ID immediately before deleting; never delete a tag or a published release.
  $fresh = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
  Confirm-ManagedDraft $fresh $release.id | Out-Null
  gh api "repos/$repo/releases/$($release.id)" --method DELETE --silent
}
$request = [ordered]@{
  tag_name = $tag
  target_commitish = $commit
  name = $tag
  body = "$notes`n`n$marker"
  draft = $true
}
$request | ConvertTo-Json -Depth 5 | Set-Content .release-gate/create-release.json -Encoding utf8NoBOM
# The creation response identifies the draft even before it appears in the release listing.
$release = gh api "repos/$repo/releases" --method POST --input .release-gate/create-release.json | ConvertFrom-Json
try { Confirm-CurrentDraft $release $null } catch { throw "Could not verify the new draft: $($_.Exception.Message)" }
foreach ($file in $files) {
  gh release upload $tag "$directory/$file" --repo $repo
}
Confirm-Assets $release.id
Confirm-Tag
$fresh = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
Confirm-CurrentDraft $fresh $release.id
gh api "repos/$repo/releases/$($release.id)" --method PATCH -F draft=false -f make_latest=legacy --silent
Write-Host "Published https://github.com/$repo/releases/tag/$tag"
