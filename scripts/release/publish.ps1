$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = $env:GITHUB_REPOSITORY
$tag = $env:GITHUB_REF_NAME
$commit = $env:GITHUB_SHA
$info = Get-Content .release-gate/info.json -Raw | ConvertFrom-Json -AsHashtable
if ($info.schemaVersion -ne 1 -or $info.repository -ne $repo -or $info.commit -ne $commit -or $info.version -ne $tag) { throw 'Gate metadata does not match this workflow.' }

function Confirm-Tag {
  git fetch --force --no-tags origin '+refs/heads/release:refs/remotes/origin/release' "+refs/tags/${tag}:refs/tags/${tag}"
  if ((git rev-parse "refs/tags/${tag}^{commit}") -ne $commit) { throw 'The release tag moved.' }
  git merge-base --is-ancestor $commit refs/remotes/origin/release
}

Confirm-Tag
$pages = gh api "repos/$repo/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$commit&per_page=100" --paginate --slurp | ConvertFrom-Json
$run = $pages.workflow_runs | Where-Object {
  $_.head_sha -eq $commit -and $_.head_branch -eq 'main' -and $_.event -eq 'push' -and $_.head_repository.full_name -eq $repo
} | Sort-Object id -Descending | Select-Object -First 1
if (!$run -or [string]$run.id -ne $info.runId -or $run.run_attempt -ne $info.runAttempt -or $run.status -ne 'completed' -or $run.conclusion -ne 'success') {
  throw 'Main CI changed after verification. Retry the release workflow after CI succeeds.'
}
$jobPages = gh api "repos/$repo/actions/runs/$($run.id)/attempts/$($run.run_attempt)/jobs?per_page=100" --paginate --slurp | ConvertFrom-Json
foreach ($name in @('quality', 'unit', 'build', 'e2e', 'release-ready')) {
  $jobs = @($jobPages.jobs | Where-Object name -EQ $name)
  if ($jobs.Count -ne 1 -or $jobs[0].status -ne 'completed' -or $jobs[0].conclusion -ne 'success') { throw "CI job $name is not successful." }
}
$directory = '.release-gate/artifact'
$files = @('main.js', 'manifest.json', 'styles.css', "lindvimera-$tag.zip", 'SHA256SUMS', 'provenance.json')
if ((Compare-Object (Get-ChildItem $directory -Force).Name $files -CaseSensitive) -or (Compare-Object @($info.hashes.Keys) $files -CaseSensitive)) { throw 'Release file inventory changed after verification.' }
foreach ($file in $files) {
  if ((Get-FileHash "$directory/$file" -Algorithm SHA256).Hash.ToLowerInvariant() -cne $info.hashes[$file]) { throw "Release file changed: $file" }
}
$identity = [ordered]@{
  schemaVersion = 1; commit = $commit; runId = $info.runId; runAttempt = $info.runAttempt
  artifactId = $info.artifactId; provenance = $info.hashes['provenance.json']
} | ConvertTo-Json -Compress
$marker = "<!-- lindvimera-release:$identity -->"

function Get-Release {
  # Authenticated listing includes drafts, unlike the tag lookup endpoint.
  $pages = gh api "repos/$repo/releases?per_page=100" --paginate --slurp | ConvertFrom-Json
  $matchingReleases = @($pages | ForEach-Object { $_ } | Where-Object tag_name -EQ $tag)
  if ($matchingReleases.Count -gt 1) { throw 'Multiple releases use this tag.' }
  return $matchingReleases | Select-Object -First 1
}

function Confirm-Assets($releaseId, [switch]$Complete) {
  $pages = gh api "repos/$repo/releases/$releaseId/assets?per_page=100" --paginate --slurp | ConvertFrom-Json
  $assets = @($pages | ForEach-Object { $_ })
  $names = @()
  foreach ($asset in $assets) {
    if ($asset.name -cnotin $files -or $asset.name -cin $names -or $asset.state -ne 'uploaded') { throw 'Unexpected or incomplete remote asset.' }
    gh release download $tag --repo $repo --pattern $asset.name --dir .release-gate/remote --clobber | Out-Null
    $remoteHash = (Get-FileHash ".release-gate/remote/$($asset.name)" -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($remoteHash -cne $info.hashes[$asset.name]) { throw "Existing release asset differs: $($asset.name)" }
    $names += $asset.name
  }
  if ($Complete -and $names.Count -ne $files.Count) { throw 'Release assets are incomplete.' }
  return $names
}

$release = Get-Release
if ($release -and !$release.body.Contains($marker)) { throw 'Existing release provenance differs; refusing to overwrite.' }
if (!$release) {
  Confirm-Tag
  $request = [ordered]@{
    tag_name = $tag
    target_commitish = $commit
    name = $tag
    body = "Lindvimera $tag`n`nVerified main CI: https://github.com/$repo/actions/runs/$($info.runId)`n`n$marker"
    draft = $true
  }
  $request | ConvertTo-Json -Depth 5 | Set-Content .release-gate/create-release.json -Encoding utf8NoBOM
  # The creation response identifies the draft even before it appears in the release listing.
  $release = gh api "repos/$repo/releases" --method POST --input .release-gate/create-release.json | ConvertFrom-Json
  if (
    !$release -or
    ($release.id -isnot [long] -and $release.id -isnot [int]) -or $release.id -le 0 -or
    $release.tag_name -isnot [string] -or $release.tag_name -cne $tag -or
    $release.draft -isnot [bool] -or !$release.draft -or
    $release.body -isnot [string] -or !$release.body.Contains($marker)
  ) { throw 'Could not verify the new draft.' }
}
$existing = @(Confirm-Assets $release.id)
if (!$release.draft) {
  if ($existing.Count -ne $files.Count) { throw 'Published release is incomplete; refusing to modify.' }
  Write-Host "Release $tag already contains these exact verified assets."
  return
}
foreach ($file in $files) {
  if ($file -notin $existing) { gh release upload $tag "$directory/$file" --repo $repo }
}
Confirm-Assets $release.id -Complete | Out-Null
Confirm-Tag
gh api "repos/$repo/releases/$($release.id)" --method PATCH -F draft=false -f make_latest=legacy --silent
Write-Host "Published https://github.com/$repo/releases/tag/$tag"
