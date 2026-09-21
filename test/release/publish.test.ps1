$ErrorActionPreference = 'Stop'
$script:ReleaseTestPublisher = Join-Path $PSScriptRoot '../../scripts/release/publish.ps1'
$script:ReleaseTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) "lindvimera-release-tests-$([guid]::NewGuid())"
$script:ReleaseTestCount = 0
$script:ReleaseTestFailures = [System.Collections.Generic.List[string]]::new()

function Assert-ReleaseTest($Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}

function Assert-ReleaseTestArguments($Actual, $Expected) {
  Assert-ReleaseTest (($Actual -join "`0") -ceq ($Expected -join "`0")) "Unexpected mock command arguments: $($Actual | ConvertTo-Json -Compress); expected: $($Expected | ConvertTo-Json -Compress)"
}

function Get-ReleaseTestCalls([string]$Kind) {
  return ,@($ReleaseTestState.Calls | Where-Object Kind -EQ $Kind)
}

function Add-ReleaseTestAssets($Names) {
  foreach ($assetName in $Names) { $ReleaseTestState.Assets.Add(@{ name = $assetName; state = 'uploaded' }) }
}

function New-ReleaseTestRelease {
  return @{ id = $ReleaseTestState.ReleaseId; tag_name = $ReleaseTestState.Tag; draft = $true; body = $ReleaseTestState.Marker }
}

function Save-ReleaseTestInfo {
  $ReleaseTestState.Info | ConvertTo-Json -Depth 10 | Set-Content .release-gate/info.json -Encoding utf8
}

function Update-ReleaseTestFiles([switch]$KeepSums, [switch]$KeepProvenanceHashes) {
  $hashes = [ordered]@{}
  foreach ($file in $ReleaseTestState.Files | Where-Object { $_ -notin @('SHA256SUMS', 'provenance.json') }) {
    $hashes[$file] = (Get-FileHash ".release/$file" -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if (!$KeepSums) {
    $lines = foreach ($file in $hashes.Keys) { "$($hashes[$file])  $file" }
    [IO.File]::WriteAllText((Join-Path (Get-Location) '.release/SHA256SUMS'), (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  }
  $hashes['SHA256SUMS'] = (Get-FileHash .release/SHA256SUMS -Algorithm SHA256).Hash.ToLowerInvariant()
  if (!$KeepProvenanceHashes) { $ReleaseTestState.Provenance.files = $hashes }
  $ReleaseTestState.Provenance | ConvertTo-Json -Depth 10 | Set-Content .release/provenance.json -Encoding utf8
  $allHashes = [ordered]@{}
  foreach ($file in $ReleaseTestState.Files) { $allHashes[$file] = (Get-FileHash ".release/$file" -Algorithm SHA256).Hash.ToLowerInvariant() }
  $ReleaseTestState.Info.hashes = $allHashes
  Save-ReleaseTestInfo
}

function Add-ReleaseTestDraft($Changes = @{}) {
  $identity = $ReleaseTestState.Identity | ConvertTo-Json | ConvertFrom-Json -AsHashtable
  $identity.runId = '999'; $identity.runAttempt = 1; $identity.provenance = ('b' * 64)
  foreach ($key in $Changes.Keys) { $identity[$key] = $Changes[$key] }
  $old = @{ id = $ReleaseTestState.OldReleaseId; tag_name = $ReleaseTestState.Tag; draft = $true; body = "<!-- lindvimera-release:$($identity | ConvertTo-Json -Compress) -->" }
  $ReleaseTestState.Releases = @($old)
  $ReleaseTestState.FreshOld = $old | ConvertTo-Json | ConvertFrom-Json -AsHashtable
  Add-ReleaseTestAssets @('main.js')
}

# Unknown calls throw so these tests cannot reach GitHub or the real Git executable.
# The publisher has its own script scope, so mocks resolve fixture state in the parent scope.
function git {
  $mockArguments = @($args)
  switch ($mockArguments[0]) {
    'fetch' {
      Assert-ReleaseTestArguments $mockArguments @('fetch', '--force', '--no-tags', 'origin', '+refs/heads/release:refs/remotes/origin/release', "+refs/tags/$($ReleaseTestState.Tag):refs/tags/$($ReleaseTestState.Tag)")
      $ReleaseTestState.Calls.Add(@{ Kind = 'fetch'; Arguments = $mockArguments })
    }
    'rev-parse' {
      Assert-ReleaseTestArguments $mockArguments @('rev-parse', "refs/tags/$($ReleaseTestState.Tag)^{commit}")
      $ReleaseTestState.TagChecks++
      if ($ReleaseTestState.TagChecks -eq $ReleaseTestState.TagMovedAt) { return 'moved-commit' }
      return $ReleaseTestState.Commit
    }
    'merge-base' {
      Assert-ReleaseTestArguments $mockArguments @('merge-base', '--is-ancestor', $ReleaseTestState.Commit, 'refs/remotes/origin/release')
      if ($ReleaseTestState.WrongBranch) { throw 'The tag is outside the release branch.' }
    }
    default { throw "Unexpected git command: $($mockArguments -join ' ')" }
  }
}

function gh {
  $mockArguments = @($args)
  $mockBase = "repos/$($ReleaseTestState.Repository)"
  if ($mockArguments[0] -eq 'attestation' -and $mockArguments[1] -eq 'verify') {
    $mockAssetName = [System.IO.Path]::GetFileName($mockArguments[2])
    Assert-ReleaseTest ($mockAssetName -cin $ReleaseTestState.Files) 'Unexpected attestation subject.'
    Assert-ReleaseTestArguments $mockArguments @('attestation', 'verify', ".release/$mockAssetName", '--repo', $ReleaseTestState.Repository, '--signer-workflow', "$($ReleaseTestState.Repository)/.github/workflows/release.yml", '--source-ref', "refs/tags/$($ReleaseTestState.Tag)", '--source-digest', $ReleaseTestState.Commit, '--deny-self-hosted-runners', '--limit', '1000')
    $ReleaseTestState.Calls.Add(@{ Kind = 'attestation'; Arguments = $mockArguments; Name = $mockAssetName })
    if ($ReleaseTestState.InvalidAttestation -ceq $mockAssetName) { throw "Attestation verification failed: $mockAssetName" }
    return
  }
  if ($mockArguments[0] -eq 'api') {
    $mockEndpoint = $mockArguments[1]
    if ($mockEndpoint -ceq "$mockBase/releases?per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      $ReleaseTestState.Calls.Add(@{ Kind = 'list'; Arguments = $mockArguments })
      # Deliberately keep the pre-creation listing stale.
      return '[' + (ConvertTo-Json -InputObject $ReleaseTestState.Releases -Depth 10 -Compress) + ']'
    }
    if ($mockEndpoint -ceq "$mockBase/releases/$($ReleaseTestState.OldReleaseId)") {
      if ($mockArguments.Count -eq 2) {
        $ReleaseTestState.Calls.Add(@{ Kind = 'read-old'; Arguments = $mockArguments })
        return $ReleaseTestState.FreshOld | ConvertTo-Json -Depth 10 -Compress
      }
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--method', 'DELETE', '--silent')
      $ReleaseTestState.Calls.Add(@{ Kind = 'delete'; Arguments = $mockArguments })
      $ReleaseTestState.Assets.Clear()
      return
    }
    if ($mockEndpoint -ceq "$mockBase/releases") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--method', 'POST', '--input', '.release-gate/create-release.json')
      $mockRequest = Get-Content -LiteralPath $mockArguments[5] -Raw | ConvertFrom-Json
      Assert-ReleaseTest ($mockRequest.tag_name -ceq $ReleaseTestState.Tag) 'Creation request has the wrong tag.'
      Assert-ReleaseTest ($mockRequest.target_commitish -ceq $ReleaseTestState.Commit) 'Creation request has the wrong commit.'
      Assert-ReleaseTest ($mockRequest.name -ceq $ReleaseTestState.Tag) 'Creation request has the wrong title.'
      Assert-ReleaseTest ($mockRequest.draft -is [bool] -and $mockRequest.draft) 'Creation request must create a draft.'
      Assert-ReleaseTest ($mockRequest.body -ceq "$($ReleaseTestState.Notes)`n`n$($ReleaseTestState.Marker)") 'Creation body must contain only the generated notes and current provenance marker.'
      $ReleaseTestState.Calls.Add(@{ Kind = 'create'; Arguments = $mockArguments; Request = $mockRequest })
      return $ReleaseTestState.CreateResponse | ConvertTo-Json -Depth 10 -Compress
    }
    if ($mockEndpoint -ceq "$mockBase/releases/$($ReleaseTestState.ReleaseId)/assets?per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      $ReleaseTestState.Calls.Add(@{ Kind = 'assets'; Arguments = $mockArguments })
      foreach ($extra in $ReleaseTestState.ExtraAssets) { $ReleaseTestState.Assets.Add($extra) }
      return '[' + (ConvertTo-Json -InputObject $ReleaseTestState.Assets.ToArray() -Depth 10 -Compress) + ']'
    }
    if ($mockEndpoint -ceq "$mockBase/releases/$($ReleaseTestState.ReleaseId)") {
      if ($mockArguments.Count -eq 2) {
        $ReleaseTestState.Calls.Add(@{ Kind = 'read-new'; Arguments = $mockArguments })
        return $ReleaseTestState.FreshNew | ConvertTo-Json -Depth 10 -Compress
      }
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=legacy', '--silent')
      $ReleaseTestState.Calls.Add(@{ Kind = 'publish'; Arguments = $mockArguments })
      return
    }
  }
  if ($mockArguments[0] -eq 'release' -and $mockArguments[1] -eq 'download') {
    $mockAssetName = $mockArguments[6]
    Assert-ReleaseTest ($mockAssetName -cin $ReleaseTestState.Files) 'Unexpected asset download.'
    Assert-ReleaseTestArguments $mockArguments @('release', 'download', $ReleaseTestState.Tag, '--repo', $ReleaseTestState.Repository, '--pattern', $mockAssetName, '--dir', '.release-gate/remote', '--clobber')
    New-Item -ItemType Directory -Path .release-gate/remote -Force | Out-Null
    Copy-Item -LiteralPath ".release/$mockAssetName" -Destination ".release-gate/remote/$mockAssetName" -Force
    if ($ReleaseTestState.CorruptRemote -ceq $mockAssetName) { Set-Content ".release-gate/remote/$mockAssetName" 'different remote content' }
    $ReleaseTestState.Calls.Add(@{ Kind = 'download'; Arguments = $mockArguments })
    return
  }
  if ($mockArguments[0] -eq 'release' -and $mockArguments[1] -eq 'upload') {
    $mockAssetName = [System.IO.Path]::GetFileName($mockArguments[3])
    Assert-ReleaseTest ($mockAssetName -cin $ReleaseTestState.Files) 'Unexpected asset upload.'
    Assert-ReleaseTestArguments $mockArguments @('release', 'upload', $ReleaseTestState.Tag, ".release/$mockAssetName", '--repo', $ReleaseTestState.Repository)
    Assert-ReleaseTest ($mockAssetName -cnotin $ReleaseTestState.Assets.name) 'Uploads must target the recreated empty draft.'
    if (!$ReleaseTestState.DropUpload) { Add-ReleaseTestAssets @($mockAssetName) }
    $ReleaseTestState.Calls.Add(@{ Kind = 'upload'; Arguments = $mockArguments; Name = $mockAssetName })
    return
  }
  throw "Unexpected gh command: $($mockArguments -join ' ')"
}

function Initialize-ReleaseTestFixture {
  $script:ReleaseTestState = @{
    Repository = 'test-owner/test-repository'; Tag = '1.2.3'; Commit = ('a' * 40); ReleaseId = 24680; OldReleaseId = 13579
    Calls = [System.Collections.Generic.List[object]]::new(); Assets = [System.Collections.Generic.List[object]]::new()
    Releases = @(); ExtraAssets = @(); TagChecks = 0; TagMovedAt = 0; WrongBranch = $false
    CorruptRemote = ''; DropUpload = $false; InvalidAttestation = ''
    Files = @('main.js', 'manifest.json', 'styles.css', 'lindvimera-1.2.3.zip', 'SHA256SUMS', 'provenance.json')
    Notes = "<!-- lindvimera-notes:start -->`n- Test release notes`n<!-- lindvimera-notes:end -->"
  }
  New-Item -ItemType Directory -Path .release, .release-gate | Out-Null
  foreach ($file in @('main.js', 'styles.css', 'lindvimera-1.2.3.zip')) { Set-Content ".release/$file" "verified fixture: $file" -Encoding utf8 }
  @{ id = 'lindvimera'; version = $ReleaseTestState.Tag } | ConvertTo-Json | Set-Content .release/manifest.json -Encoding utf8
  $ReleaseTestState.Info = [ordered]@{
    schemaVersion = 2; repository = $ReleaseTestState.Repository; commit = $ReleaseTestState.Commit
    version = $ReleaseTestState.Tag; runId = '1234'; runAttempt = 2; hashes = @{}
  }
  $ReleaseTestState.Provenance = [ordered]@{
    schemaVersion = 2; repository = $ReleaseTestState.Repository; commit = $ReleaseTestState.Commit
    version = $ReleaseTestState.Tag; runId = '1234'; runAttempt = 2; files = @{}
  }
  Update-ReleaseTestFiles
  $ReleaseTestState.Identity = [ordered]@{
    schemaVersion = 2; repository = $ReleaseTestState.Repository; commit = $ReleaseTestState.Commit; version = $ReleaseTestState.Tag
    runId = '1234'; runAttempt = 2; provenance = $ReleaseTestState.Info.hashes['provenance.json']
  }
  $ReleaseTestState.Marker = "<!-- lindvimera-release:$($ReleaseTestState.Identity | ConvertTo-Json -Compress) -->"
  $ReleaseTestState.CreateResponse = New-ReleaseTestRelease
  $ReleaseTestState.FreshNew = New-ReleaseTestRelease
  Set-Content .release-gate/notes.md $ReleaseTestState.Notes -Encoding utf8
  $env:GITHUB_REPOSITORY = $ReleaseTestState.Repository
  $env:GITHUB_REF_NAME = $ReleaseTestState.Tag
  $env:GITHUB_REF_TYPE = 'tag'
  $env:GITHUB_SHA = $ReleaseTestState.Commit
  $env:GITHUB_RUN_ID = '1234'
  $env:GITHUB_RUN_ATTEMPT = '2'
}

function Assert-ReleaseTestNoWrites {
  foreach ($kind in @('delete', 'create', 'upload', 'publish')) { Assert-ReleaseTest ((Get-ReleaseTestCalls $kind).Count -eq 0) "Unexpected $kind operation." }
}

function Assert-ReleaseTestNoPublish {
  Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 0) 'Unexpected publication.'
}

function Invoke-ReleaseTestCase([string]$Name, [scriptblock]$Arrange = {}, [string]$Failure = '', [scriptblock]$Verify = {}) {
  $script:ReleaseTestCount++
  $caseDirectory = Join-Path $script:ReleaseTestRoot ([string]$script:ReleaseTestCount)
  New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
  Push-Location -LiteralPath $caseDirectory
  try {
    Initialize-ReleaseTestFixture
    & $Arrange
    $publisherError = $null
    try { & $script:ReleaseTestPublisher } catch { $publisherError = $_ }
    if ($Failure) {
      Assert-ReleaseTest ($null -ne $publisherError) "Expected failure matching: $Failure"
      Assert-ReleaseTest ($publisherError.Exception.Message -match $Failure) "Unexpected publisher error: $($publisherError.Exception.Message)"
    } elseif ($publisherError) { throw $publisherError }
    & $Verify
    Write-Host "PASS $Name"
  } catch {
    $script:ReleaseTestFailures.Add("${Name}: $($_.Exception.Message)")
    Write-Host "FAIL ${Name}: $($_.Exception.Message)"
  } finally { Pop-Location }
}

$savedReleaseTestEnvironment = @{}
foreach ($name in @('GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_REF_TYPE', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')) {
  $savedReleaseTestEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  Invoke-ReleaseTestCase 'creates and publishes from the response despite stale listing' -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'attestation').Count -eq 6) 'All six files require attestations.'
    Assert-ReleaseTest (($ReleaseTestState.Calls | Where-Object Kind -In @('attestation', 'create') | Select-Object -Last 1).Kind -eq 'create') 'Attestations must precede draft creation.'
    foreach ($kind in @('list', 'create', 'assets', 'read-new', 'publish')) { Assert-ReleaseTest ((Get-ReleaseTestCalls $kind).Count -eq 1) "Expected exactly one $kind operation." }
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 6) 'Expected all six uploads.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'download').Count -eq 6) 'Expected all six remote checks.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'delete').Count -eq 0) 'A new release must not delete anything.'
  }
  Invoke-ReleaseTestCase 'recreates a matching draft from an older build without reusing assets' -Arrange { Add-ReleaseTestDraft } -Verify {
    $order = @($ReleaseTestState.Calls | Where-Object Kind -In @('read-old', 'delete', 'create', 'read-new', 'publish') | ForEach-Object Kind)
    Assert-ReleaseTestArguments $order @('read-old', 'delete', 'create', 'read-new', 'publish')
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 6) 'Retry must upload the whole fresh build.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'attestation').Count -eq 6) 'Verify the new build before deleting a draft.'
  }
  foreach ($publishedBody in @('', '<!-- lindvimera-release:{"schemaVersion":1} -->', 'current')) {
    Invoke-ReleaseTestCase "never changes a published release with body '$publishedBody'" -Arrange {
      $release = New-ReleaseTestRelease; $release.draft = $false
      if ($publishedBody -ne 'current') { $release.body = $publishedBody }
      $ReleaseTestState.Releases = @($release)
    } -Failure 'already published' -Verify { Assert-ReleaseTestNoWrites }
  }
  $invalidDrafts = @(
    @{ schemaVersion = 1 }, @{ repository = 'other/repository' }, @{ commit = ('b' * 40) }, @{ version = '9.9.9' },
    @{ runId = 1234 }, @{ runId = '' }, @{ runAttempt = '1' }, @{ runAttempt = 0 }, @{ provenance = 'bad-hash' }
  )
  foreach ($change in $invalidDrafts) {
    Invoke-ReleaseTestCase "rejects draft identity $($change | ConvertTo-Json -Compress)" -Arrange { Add-ReleaseTestDraft $change } -Failure 'not a matching managed release' -Verify { Assert-ReleaseTestNoWrites }
  }
  foreach ($badBody in @('unmanaged draft', '<!-- lindvimera-release:{bad} -->', '<!-- lindvimera-release:{}', '<!-- lindvimera-release:[] -->', '<!-- lindvimera-release:null -->', 'duplicate', 'truncated duplicate')) {
    Invoke-ReleaseTestCase "rejects draft marker '$badBody'" -Arrange {
      Add-ReleaseTestDraft
      $body = $badBody
      if ($badBody -eq 'duplicate') { $body = "$($ReleaseTestState.Marker)`n$($ReleaseTestState.Marker)" }
      if ($badBody -eq 'truncated duplicate') { $body = "$($ReleaseTestState.Marker)`n<!-- lindvimera-release:{" }
      $ReleaseTestState.Releases[0].body = $body
    } -Failure 'publication marker|matching managed release' -Verify { Assert-ReleaseTestNoWrites }
  }
  foreach ($freshChange in @('published', 'tag', 'id', 'marker')) {
    Invoke-ReleaseTestCase "rechecks an old draft before deletion: $freshChange" -Arrange {
      Add-ReleaseTestDraft
      switch ($freshChange) {
        'published' { $ReleaseTestState.FreshOld.draft = $false }
        'tag' { $ReleaseTestState.FreshOld.tag_name = '9.9.9' }
        'id' { $ReleaseTestState.FreshOld.id = 123 }
        'marker' { $ReleaseTestState.FreshOld.body = 'changed manually' }
      }
    } -Failure 'already published|managed draft|publication marker' -Verify { Assert-ReleaseTestNoWrites }
  }
  $invalidResponses = @(
    @{ Name = 'missing ID'; Field = 'id'; Value = $null }, @{ Name = 'zero ID'; Field = 'id'; Value = 0 },
    @{ Name = 'negative ID'; Field = 'id'; Value = -1 }, @{ Name = 'string ID'; Field = 'id'; Value = '24680' },
    @{ Name = 'fractional ID'; Field = 'id'; Value = 1.5 }, @{ Name = 'Boolean ID'; Field = 'id'; Value = $true },
    @{ Name = 'different tag'; Field = 'tag_name'; Value = '9.9.9' }, @{ Name = 'missing tag'; Field = 'tag_name'; Value = $null },
    @{ Name = 'published response'; Field = 'draft'; Value = $false }, @{ Name = 'string draft'; Field = 'draft'; Value = 'true' },
    @{ Name = 'missing draft'; Field = 'draft'; Value = $null }, @{ Name = 'different provenance'; Field = 'body'; Value = '<!-- lindvimera-release:other -->' },
    @{ Name = 'missing body'; Field = 'body'; Value = $null }, @{ Name = 'object body'; Field = 'body'; Value = @{ unexpected = 'body' } }
  )
  foreach ($response in $invalidResponses) {
    Invoke-ReleaseTestCase "rejects creation response with $($response.Name)" -Arrange {
      $ReleaseTestState.CreateResponse[$response.Field] = $response.Value
    } -Failure 'Could not verify the new draft' -Verify {
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'create').Count -eq 1) 'The creation response must be checked.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'list').Count -eq 1) 'Do not fall back to stale listing.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 0) 'Invalid creation must prevent uploads.'
      Assert-ReleaseTestNoPublish
    }
  }
  foreach ($field in @('repository', 'commit', 'version', 'runId', 'runAttempt', 'schemaVersion')) {
    Invoke-ReleaseTestCase "rejects mismatched build metadata $field" -Arrange {
      $ReleaseTestState.Info[$field] = if ($field -in @('runAttempt', 'schemaVersion')) { 99 } else { 'different' }
      Save-ReleaseTestInfo
    } -Failure 'Build metadata does not match' -Verify { Assert-ReleaseTestNoWrites }
    Invoke-ReleaseTestCase "rejects mismatched provenance $field" -Arrange {
      $ReleaseTestState.Provenance[$field] = if ($field -in @('runAttempt', 'schemaVersion')) { 99 } else { 'different' }
      Update-ReleaseTestFiles
    } -Failure 'Release provenance does not match' -Verify { Assert-ReleaseTestNoWrites }
  }
  foreach ($field in @('repository', 'commit', 'version')) {
    foreach ($badKind in @('empty array', 'matching array', 'null', 'object')) {
      Invoke-ReleaseTestCase "rejects $badKind build metadata $field" -Arrange {
        switch ($badKind) {
          'empty array' { $ReleaseTestState.Info[$field] = @() }
          'matching array' { $ReleaseTestState.Info[$field] = @($ReleaseTestState.Info[$field]) }
          'null' { $ReleaseTestState.Info[$field] = $null }
          'object' { $ReleaseTestState.Info[$field] = @{ value = $ReleaseTestState.Info[$field] } }
        }
        Save-ReleaseTestInfo
      } -Failure 'Build metadata does not match' -Verify { Assert-ReleaseTestNoWrites }
      Invoke-ReleaseTestCase "rejects $badKind provenance $field" -Arrange {
        switch ($badKind) {
          'empty array' { $ReleaseTestState.Provenance[$field] = @() }
          'matching array' { $ReleaseTestState.Provenance[$field] = @($ReleaseTestState.Provenance[$field]) }
          'null' { $ReleaseTestState.Provenance[$field] = $null }
          'object' { $ReleaseTestState.Provenance[$field] = @{ value = $ReleaseTestState.Provenance[$field] } }
        }
        Update-ReleaseTestFiles
      } -Failure 'Release provenance does not match' -Verify { Assert-ReleaseTestNoWrites }
      Invoke-ReleaseTestCase "rejects $badKind draft marker $field" -Arrange {
        $invalid = @{}
        switch ($badKind) {
          'empty array' { $invalid[$field] = @() }
          'matching array' { $invalid[$field] = @($ReleaseTestState.Identity[$field]) }
          'null' { $invalid[$field] = $null }
          'object' { $invalid[$field] = @{ value = $ReleaseTestState.Identity[$field] } }
        }
        Add-ReleaseTestDraft $invalid
      } -Failure 'not a matching managed release' -Verify { Assert-ReleaseTestNoWrites }
    }
  }
  Invoke-ReleaseTestCase 'rejects a singleton array build metadata envelope' -Arrange {
    $text = Get-Content .release-gate/info.json -Raw; Set-Content .release-gate/info.json "[$text]"
  } -Failure 'Build metadata does not match' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects a singleton array provenance envelope' -Arrange {
    $text = Get-Content .release/provenance.json -Raw; Set-Content .release/provenance.json "[$text]"
  } -Failure 'Release provenance does not match' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects a singleton array draft marker envelope' -Arrange {
    Add-ReleaseTestDraft
    $ReleaseTestState.Releases[0].body = "<!-- lindvimera-release:[$($ReleaseTestState.Identity | ConvertTo-Json -Compress)] -->"
  } -Failure 'not a matching managed release' -Verify { Assert-ReleaseTestNoWrites }
  foreach ($environmentChange in @(@{ Name = 'GITHUB_REF_TYPE'; Value = 'branch' }, @{ Name = 'GITHUB_REF_NAME'; Value = 'v1.2.3' }, @{ Name = 'GITHUB_RUN_ID'; Value = '' }, @{ Name = 'GITHUB_RUN_ATTEMPT'; Value = '0' }, @{ Name = 'GITHUB_SHA'; Value = 'a123' }, @{ Name = 'GITHUB_SHA'; Value = ('A' * 40) })) {
    Invoke-ReleaseTestCase "rejects invalid workflow environment $($environmentChange.Name)" -Arrange {
      [Environment]::SetEnvironmentVariable($environmentChange.Name, $environmentChange.Value, 'Process')
    } -Failure 'Publication requires' -Verify { Assert-ReleaseTestNoWrites }
  }
  Invoke-ReleaseTestCase 'rejects locally changed content without deleting an existing draft' -Arrange {
    Add-ReleaseTestDraft; Add-Content .release/main.js 'tampered'
  } -Failure 'Release file changed: main.js' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects extra local files' -Arrange { Set-Content .release/extra.txt 'extra' } -Failure 'file inventory' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects missing local files' -Arrange { Remove-Item .release/main.js } -Failure 'file inventory' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects incomplete metadata hashes' -Arrange { $ReleaseTestState.Info.hashes.Remove('main.js'); Save-ReleaseTestInfo } -Failure 'file inventory' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects incomplete provenance hashes' -Arrange {
    $ReleaseTestState.Provenance.files.Remove('main.js'); Update-ReleaseTestFiles -KeepProvenanceHashes
  } -Failure 'provenance inventory' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects mismatched provenance checksum' -Arrange {
    $ReleaseTestState.Provenance.files['main.js'] = ('0' * 64); Update-ReleaseTestFiles -KeepProvenanceHashes
  } -Failure 'Provenance checksum mismatch' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects invalid SHA256SUMS syntax' -Arrange {
    Set-Content .release/SHA256SUMS 'bad checksum'; Update-ReleaseTestFiles -KeepSums
  } -Failure 'Invalid SHA256SUMS' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects duplicate SHA256SUMS entries' -Arrange {
    $line = Get-Content .release/SHA256SUMS | Select-Object -First 1; Add-Content .release/SHA256SUMS $line; Update-ReleaseTestFiles -KeepSums
  } -Failure 'Invalid SHA256SUMS' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects incomplete SHA256SUMS' -Arrange {
    $line = Get-Content .release/SHA256SUMS | Select-Object -First 1; Set-Content .release/SHA256SUMS $line; Update-ReleaseTestFiles -KeepSums
  } -Failure 'Incomplete SHA256SUMS' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects incorrect SHA256SUMS hash' -Arrange {
    $text = Get-Content .release/SHA256SUMS -Raw; $text = $text.Replace($ReleaseTestState.Info.hashes['main.js'], ('0' * 64))
    Set-Content .release/SHA256SUMS $text -NoNewline; Update-ReleaseTestFiles -KeepSums
  } -Failure 'SHA256SUMS mismatch' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects manifest version mismatch' -Arrange {
    @{ id = 'lindvimera'; version = '9.9.9' } | ConvertTo-Json | Set-Content .release/manifest.json; Update-ReleaseTestFiles
  } -Failure 'Release manifest differs' -Verify { Assert-ReleaseTestNoWrites }
  foreach ($file in @('main.js', 'manifest.json', 'styles.css', 'lindvimera-1.2.3.zip', 'SHA256SUMS', 'provenance.json')) {
    Invoke-ReleaseTestCase "rejects failed attestation for $file without deleting a draft" -Arrange {
      Add-ReleaseTestDraft; $ReleaseTestState.InvalidAttestation = $file
    } -Failure 'Attestation verification failed' -Verify { Assert-ReleaseTestNoWrites }
  }
  Invoke-ReleaseTestCase 'rejects notes containing a provenance marker' -Arrange { Set-Content .release-gate/notes.md $ReleaseTestState.Marker } -Failure 'notes are empty or contain' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects empty notes' -Arrange { Set-Content .release-gate/notes.md '' } -Failure 'notes are empty or contain' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects remote content with a different checksum' -Arrange { $ReleaseTestState.CorruptRemote = 'main.js' } -Failure 'Existing release asset differs' -Verify { Assert-ReleaseTestNoPublish }
  Invoke-ReleaseTestCase 'requires all uploads before publishing' -Arrange { $ReleaseTestState.DropUpload = $true } -Failure 'Release assets are incomplete' -Verify { Assert-ReleaseTestNoPublish }
  foreach ($extraAsset in @(@{ name = 'unknown.txt'; state = 'uploaded' }, @{ name = 'main.js'; state = 'uploaded' }, @{ name = 'pending.txt'; state = 'starter' })) {
    Invoke-ReleaseTestCase "rejects unexpected remote asset $($extraAsset | ConvertTo-Json -Compress)" -Arrange { $ReleaseTestState.ExtraAssets = @($extraAsset) } -Failure 'Unexpected or incomplete remote asset' -Verify { Assert-ReleaseTestNoPublish }
  }
  foreach ($change in @('published', 'tag', 'id', 'marker', 'build')) {
    Invoke-ReleaseTestCase "rechecks the new draft before publication: $change" -Arrange {
      switch ($change) {
        'published' { $ReleaseTestState.FreshNew.draft = $false }
        'tag' { $ReleaseTestState.FreshNew.tag_name = '9.9.9' }
        'id' { $ReleaseTestState.FreshNew.id = 123 }
        'marker' { $ReleaseTestState.FreshNew.body = 'changed manually' }
        'build' { $ReleaseTestState.FreshNew.body = $ReleaseTestState.Marker.Replace('"runAttempt":2', '"runAttempt":1') }
      }
    } -Failure 'already published|managed draft|publication marker|does not match this build' -Verify { Assert-ReleaseTestNoPublish }
  }
  Invoke-ReleaseTestCase 'rejects a tag outside release history' -Arrange { $ReleaseTestState.WrongBranch = $true } -Failure 'outside the release branch' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects a tag moved at startup' -Arrange { $ReleaseTestState.TagMovedAt = 1 } -Failure 'release tag moved' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rechecks the tag before deleting a draft' -Arrange { Add-ReleaseTestDraft; $ReleaseTestState.TagMovedAt = 2 } -Failure 'release tag moved' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rechecks the tag after uploads' -Arrange { $ReleaseTestState.TagMovedAt = 3 } -Failure 'release tag moved' -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 6) 'Expected uploads before the final tag check.'
    Assert-ReleaseTestNoPublish
  }
  Invoke-ReleaseTestCase 'rejects multiple releases for the same tag' -Arrange {
    $ReleaseTestState.Releases = @((New-ReleaseTestRelease), (New-ReleaseTestRelease))
  } -Failure 'Multiple releases' -Verify { Assert-ReleaseTestNoWrites }
} finally {
  foreach ($name in $savedReleaseTestEnvironment.Keys) { [System.Environment]::SetEnvironmentVariable($name, $savedReleaseTestEnvironment[$name], 'Process') }
  if (Test-Path -LiteralPath $script:ReleaseTestRoot) {
    $resolvedTestRoot = (Resolve-Path -LiteralPath $script:ReleaseTestRoot).ProviderPath
    $expectedTestRoot = [System.IO.Path]::GetFullPath($script:ReleaseTestRoot)
    $allowedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedTestRoot -cne $expectedTestRoot -or !$resolvedTestRoot.StartsWith($allowedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing recursive cleanup outside the test temporary root: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
if ($script:ReleaseTestFailures.Count) { throw "$($script:ReleaseTestFailures.Count)/$script:ReleaseTestCount release publication tests failed:`n$($script:ReleaseTestFailures -join "`n")" }
Write-Host "All $script:ReleaseTestCount release publication tests passed."
