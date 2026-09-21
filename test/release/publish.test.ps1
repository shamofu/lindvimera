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
  foreach ($assetName in $Names) {
    $ReleaseTestState.Assets.Add(@{ name = $assetName; state = 'uploaded' })
  }
}

function New-ReleaseTestRelease([bool]$Draft = $true) {
  return @{ id = $ReleaseTestState.ReleaseId; tag_name = $ReleaseTestState.Tag; draft = $Draft; body = $ReleaseTestState.Marker }
}

# These functions shadow the native commands in the publisher's child scope.
# Unknown calls throw; tests can never fall through to real GitHub or Git operations.
# Resolve the uniquely named fixture state through the parent scope: $script:
# would refer to the publisher's script scope when it calls these mocks.
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
    }
    default { throw "Unexpected git command: $($mockArguments -join ' ')" }
  }
}

function gh {
  $mockArguments = @($args)
  $mockBase = "repos/$($ReleaseTestState.Repository)"
  if ($mockArguments[0] -eq 'api') {
    $mockEndpoint = $mockArguments[1]
    if ($mockEndpoint -ceq "$mockBase/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$($ReleaseTestState.Commit)&per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      return ConvertTo-Json -InputObject @(@{ workflow_runs = @($ReleaseTestState.Run) }) -Depth 10 -Compress
    }
    if ($mockEndpoint -ceq "$mockBase/actions/runs/$($ReleaseTestState.Run.id)/attempts/$($ReleaseTestState.Run.run_attempt)/jobs?per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      return ConvertTo-Json -InputObject @(@{ jobs = $ReleaseTestState.Jobs }) -Depth 10 -Compress
    }
    if ($mockEndpoint -ceq "$mockBase/releases?per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      $ReleaseTestState.Calls.Add(@{ Kind = 'list'; Arguments = $mockArguments })
      # Keep returning the original list after creation to simulate stale listing.
      return '[' + (ConvertTo-Json -InputObject $ReleaseTestState.Releases -Depth 10 -Compress) + ']'
    }
    if ($mockEndpoint -ceq "$mockBase/releases") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--method', 'POST', '--input', '.release-gate/create-release.json')
      $mockRequest = Get-Content -LiteralPath $mockArguments[5] -Raw | ConvertFrom-Json
      Assert-ReleaseTest ($mockRequest.tag_name -ceq $ReleaseTestState.Tag) 'Creation request has the wrong tag.'
      Assert-ReleaseTest ($mockRequest.target_commitish -ceq $ReleaseTestState.Commit) 'Creation request has the wrong commit.'
      Assert-ReleaseTest ($mockRequest.name -ceq $ReleaseTestState.Tag) 'Creation request has the wrong title.'
      Assert-ReleaseTest ($mockRequest.draft -is [bool] -and $mockRequest.draft) 'Creation request must create a draft.'
      Assert-ReleaseTest ($mockRequest.body -is [string] -and $mockRequest.body.Contains($ReleaseTestState.Marker)) 'Creation request lacks verified provenance.'
      $ReleaseTestState.Calls.Add(@{ Kind = 'create'; Arguments = $mockArguments; Request = $mockRequest })
      return ConvertTo-Json -InputObject $ReleaseTestState.CreateResponse -Depth 10 -Compress
    }
    if ($mockEndpoint -ceq "$mockBase/releases/$($ReleaseTestState.ReleaseId)/assets?per_page=100") {
      Assert-ReleaseTestArguments $mockArguments @('api', $mockEndpoint, '--paginate', '--slurp')
      $ReleaseTestState.Calls.Add(@{ Kind = 'assets'; Arguments = $mockArguments })
      return '[' + (ConvertTo-Json -InputObject $ReleaseTestState.Assets.ToArray() -Depth 10 -Compress) + ']'
    }
    if ($mockEndpoint -ceq "$mockBase/releases/$($ReleaseTestState.ReleaseId)") {
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
    Copy-Item -LiteralPath ".release-gate/artifact/$mockAssetName" -Destination ".release-gate/remote/$mockAssetName" -Force
    if ($ReleaseTestState.CorruptRemote -ceq $mockAssetName) {
      Set-Content -LiteralPath ".release-gate/remote/$mockAssetName" -Value 'different remote content'
    }
    $ReleaseTestState.Calls.Add(@{ Kind = 'download'; Arguments = $mockArguments })
    return
  }
  if ($mockArguments[0] -eq 'release' -and $mockArguments[1] -eq 'upload') {
    $mockAssetName = [System.IO.Path]::GetFileName($mockArguments[3])
    Assert-ReleaseTest ($mockAssetName -cin $ReleaseTestState.Files) 'Unexpected asset upload.'
    Assert-ReleaseTestArguments $mockArguments @('release', 'upload', $ReleaseTestState.Tag, ".release-gate/artifact/$mockAssetName", '--repo', $ReleaseTestState.Repository)
    Assert-ReleaseTest ($mockAssetName -cnotin $ReleaseTestState.Assets.name) 'Existing assets must not be uploaded again.'
    if (!$ReleaseTestState.DropUpload) { Add-ReleaseTestAssets @($mockAssetName) }
    $ReleaseTestState.Calls.Add(@{ Kind = 'upload'; Arguments = $mockArguments; Name = $mockAssetName })
    return
  }
  throw "Unexpected gh command: $($mockArguments -join ' ')"
}

function Initialize-ReleaseTestFixture {
  $script:ReleaseTestState = @{
    Repository = 'test-owner/test-repository'; Tag = '1.2.3'; Commit = ('a' * 40); ReleaseId = 24680
    Calls = [System.Collections.Generic.List[object]]::new(); Assets = [System.Collections.Generic.List[object]]::new()
    Releases = @(); TagChecks = 0; TagMovedAt = 0; CorruptRemote = ''; DropUpload = $false
    Files = @('main.js', 'manifest.json', 'styles.css', 'lindvimera-1.2.3.zip', 'SHA256SUMS', 'provenance.json')
    Jobs = @('quality', 'unit', 'build', 'e2e', 'release-ready') | ForEach-Object { @{ name = $_; status = 'completed'; conclusion = 'success' } }
  }
  $ReleaseTestState.Run = @{
    id = 1234; run_attempt = 2; head_sha = $ReleaseTestState.Commit; head_branch = 'main'; event = 'push'
    head_repository = @{ full_name = $ReleaseTestState.Repository }; status = 'completed'; conclusion = 'success'
  }
  New-Item -ItemType Directory -Path .release-gate/artifact | Out-Null
  $fixtureHashes = [ordered]@{}
  foreach ($fixtureName in $ReleaseTestState.Files) {
    Set-Content -LiteralPath ".release-gate/artifact/$fixtureName" -Value "verified fixture: $fixtureName" -Encoding utf8
    $fixtureHashes[$fixtureName] = (Get-FileHash -LiteralPath ".release-gate/artifact/$fixtureName" -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $ReleaseTestState.Info = [ordered]@{
    schemaVersion = 1; repository = $ReleaseTestState.Repository; commit = $ReleaseTestState.Commit
    version = $ReleaseTestState.Tag; runId = '1234'; runAttempt = 2; artifactId = 5678; hashes = $fixtureHashes
  }
  $ReleaseTestState.Info | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath .release-gate/info.json -Encoding utf8
  $fixtureIdentity = [ordered]@{
    schemaVersion = 1; commit = $ReleaseTestState.Commit; runId = '1234'; runAttempt = 2
    artifactId = 5678; provenance = $fixtureHashes['provenance.json']
  } | ConvertTo-Json -Compress
  $ReleaseTestState.Marker = "<!-- lindvimera-release:$fixtureIdentity -->"
  $ReleaseTestState.CreateResponse = New-ReleaseTestRelease
  $env:GITHUB_REPOSITORY = $ReleaseTestState.Repository
  $env:GITHUB_REF_NAME = $ReleaseTestState.Tag
  $env:GITHUB_SHA = $ReleaseTestState.Commit
}

function Assert-ReleaseTestNoWrites {
  Assert-ReleaseTest ((Get-ReleaseTestCalls 'create').Count -eq 0) 'Unexpected draft creation.'
  Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 0) 'Unexpected asset upload.'
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
    } elseif ($publisherError) {
      throw $publisherError
    }
    & $Verify
    Write-Host "PASS $Name"
  } catch {
    $script:ReleaseTestFailures.Add("${Name}: $($_.Exception.Message)")
    Write-Host "FAIL ${Name}: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

$savedReleaseTestEnvironment = @{}
foreach ($environmentName in @('GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_SHA')) {
  $savedReleaseTestEnvironment[$environmentName] = [System.Environment]::GetEnvironmentVariable($environmentName, 'Process')
}
try {
  Invoke-ReleaseTestCase 'creates and publishes using the response while the release list stays empty' -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'list').Count -eq 1) 'Creation must not reread the release list.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'create').Count -eq 1) 'Expected exactly one draft creation.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'assets').Count -eq 2) 'Expected checks before and after upload using the returned release ID.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 6) 'Expected all six verified assets to be uploaded.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 1) 'Expected one publication using the returned release ID.'
  }

  $invalidResponses = @(
    @{ Name = 'missing ID'; Field = 'id'; Value = $null },
    @{ Name = 'zero ID'; Field = 'id'; Value = 0 },
    @{ Name = 'negative ID'; Field = 'id'; Value = -1 },
    @{ Name = 'string ID'; Field = 'id'; Value = '24680' },
    @{ Name = 'fractional ID'; Field = 'id'; Value = 24680.5 },
    @{ Name = 'Boolean ID'; Field = 'id'; Value = $true },
    @{ Name = 'different tag'; Field = 'tag_name'; Value = '9.9.9' },
    @{ Name = 'missing tag'; Field = 'tag_name'; Value = $null },
    @{ Name = 'published response'; Field = 'draft'; Value = $false },
    @{ Name = 'string draft'; Field = 'draft'; Value = 'true' },
    @{ Name = 'missing draft'; Field = 'draft'; Value = $null },
    @{ Name = 'different provenance'; Field = 'body'; Value = '<!-- lindvimera-release:other -->' },
    @{ Name = 'missing body'; Field = 'body'; Value = $null },
    @{ Name = 'object body'; Field = 'body'; Value = @{ unexpected = 'body' } }
  )
  foreach ($invalidResponse in $invalidResponses) {
    Invoke-ReleaseTestCase "rejects creation response with $($invalidResponse.Name)" -Arrange {
      $ReleaseTestState.CreateResponse[$invalidResponse.Field] = $invalidResponse.Value
    } -Failure 'Could not verify the new draft' -Verify {
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'create').Count -eq 1) 'Expected the draft creation response to be checked.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'list').Count -eq 1) 'Invalid responses must not fall back to listing.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'assets').Count -eq 0) 'Invalid responses must fail before checking remote assets.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 0) 'Invalid responses must fail before upload.'
      Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 0) 'Invalid responses must fail before publication.'
    }
  }

  Invoke-ReleaseTestCase 'resumes a matching partial draft without overwriting existing assets' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    Add-ReleaseTestAssets @('main.js', 'manifest.json')
  } -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'create').Count -eq 0) 'Existing drafts must be reused.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 4) 'Only missing files should be uploaded.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 1) 'The completed draft should be published.'
  }
  Invoke-ReleaseTestCase 'returns normally for an identical published release' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease $false)
    Add-ReleaseTestAssets $ReleaseTestState.Files
  } -Verify {
    Assert-ReleaseTestNoWrites
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'download').Count -eq 6) 'Published assets must all be verified.'
  }
  Invoke-ReleaseTestCase 'refuses to repair an incomplete published release' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease $false)
    Add-ReleaseTestAssets @('main.js')
  } -Failure 'Published release is incomplete' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects an existing release with different provenance' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    $ReleaseTestState.Releases[0].body = '<!-- lindvimera-release:other -->'
  } -Failure 'Existing release provenance differs' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects locally changed release content' -Arrange {
    Add-Content -LiteralPath .release-gate/artifact/main.js -Value 'tampered'
  } -Failure 'Release file changed: main.js' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects remote content with a different checksum' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    Add-ReleaseTestAssets @('main.js')
    $ReleaseTestState.CorruptRemote = 'main.js'
  } -Failure 'Existing release asset differs: main.js' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects changed CI after verification' -Arrange {
    $ReleaseTestState.Run.run_attempt++
  } -Failure 'Main CI changed after verification' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects an unsuccessful required CI job' -Arrange {
    $ReleaseTestState.Jobs[3].conclusion = 'failure'
  } -Failure 'CI job e2e is not successful' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects a tag moved before publication starts' -Arrange {
    $ReleaseTestState.TagMovedAt = 1
  } -Failure 'The release tag moved' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rechecks the tag before publishing the completed draft' -Arrange {
    $ReleaseTestState.TagMovedAt = 3
  } -Failure 'The release tag moved' -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'upload').Count -eq 6) 'Expected the final tag check after asset upload.'
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 0) 'A moved tag must prevent publication.'
  }
  Invoke-ReleaseTestCase 'rejects multiple releases with the same tag' -Arrange {
    $ReleaseTestState.Releases = @((New-ReleaseTestRelease), (New-ReleaseTestRelease))
  } -Failure 'Multiple releases use this tag' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects an unexpected remote asset' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    Add-ReleaseTestAssets @('unknown.txt')
  } -Failure 'Unexpected or incomplete remote asset' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects duplicate remote assets' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    Add-ReleaseTestAssets @('main.js', 'main.js')
  } -Failure 'Unexpected or incomplete remote asset' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'rejects remote assets whose upload did not complete' -Arrange {
    $ReleaseTestState.Releases = @(New-ReleaseTestRelease)
    $ReleaseTestState.Assets.Add(@{ name = 'main.js'; state = 'starter' })
  } -Failure 'Unexpected or incomplete remote asset' -Verify { Assert-ReleaseTestNoWrites }
  Invoke-ReleaseTestCase 'requires complete remote assets before publication' -Arrange {
    $ReleaseTestState.DropUpload = $true
  } -Failure 'Release assets are incomplete' -Verify {
    Assert-ReleaseTest ((Get-ReleaseTestCalls 'publish').Count -eq 0) 'Incomplete uploads must prevent publication.'
  }
} finally {
  foreach ($environmentName in $savedReleaseTestEnvironment.Keys) {
    [System.Environment]::SetEnvironmentVariable($environmentName, $savedReleaseTestEnvironment[$environmentName], 'Process')
  }
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
if ($script:ReleaseTestFailures.Count) {
  throw "$($script:ReleaseTestFailures.Count)/$script:ReleaseTestCount release publication tests failed:`n$($script:ReleaseTestFailures -join "`n")"
}
Write-Host "All $script:ReleaseTestCount release publication tests passed."
