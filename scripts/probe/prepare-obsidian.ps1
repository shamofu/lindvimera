$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (!$env:GITHUB_WORKSPACE -or !$env:GITHUB_ENV) {
  throw 'Obsidian preparation requires GITHUB_WORKSPACE and GITHUB_ENV.'
}
$taskCache = Join-Path $env:GITHUB_WORKSPACE '.cache/obsidian/1.15.0'
$taskRuntime = Join-Path $env:GITHUB_WORKSPACE '.test-runtime'
New-Item -ItemType Directory -Force -Path $taskCache, $taskRuntime | Out-Null
$taskAssets = @{
  'Obsidian-1.15.0.exe' = 'b0f60c75a12f96d54cb16b9fc32919966f2ebf029d9af75d67a19ba6555e1da0'
  'obsidian-1.15.0.asar.gz' = '011c70f176e44f0b215597cf0d420bae424be73583f2cb0205d3e63a26a0aa40'
}
foreach ($taskAsset in $taskAssets.GetEnumerator()) {
  $taskPath = Join-Path $taskCache $taskAsset.Key
  if (!(Test-Path -LiteralPath $taskPath) -or (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    Invoke-WebRequest -Uri "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/$($taskAsset.Key)" -OutFile $taskPath
  }
  if ((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    throw "Obsidian asset checksum mismatch: $($taskAsset.Key)"
  }
}
$taskInstall = Join-Path $taskRuntime 'obsidian-install'
$taskInstaller = Start-Process -FilePath (Join-Path $taskCache 'Obsidian-1.15.0.exe') -ArgumentList '/S', "/D=$taskInstall" -WindowStyle Hidden -Wait -PassThru
if ($taskInstaller.ExitCode -ne 0) { throw "Obsidian installer failed: $($taskInstaller.ExitCode)" }
$taskExecutable = Join-Path $taskInstall 'Obsidian.exe'
if (!(Test-Path -LiteralPath $taskExecutable)) { throw 'Obsidian executable is missing.' }
$taskArchive = Join-Path $taskRuntime 'obsidian-1.15.0.asar'
$taskInput = [IO.Compression.GZipStream]::new([IO.File]::OpenRead((Join-Path $taskCache 'obsidian-1.15.0.asar.gz')), [IO.Compression.CompressionMode]::Decompress)
try {
  $taskOutput = [IO.File]::Create($taskArchive)
  try { $taskInput.CopyTo($taskOutput) } finally { $taskOutput.Dispose() }
} finally { $taskInput.Dispose() }
"OBSIDIAN_EXECUTABLE=$taskExecutable" >> $env:GITHUB_ENV
"OBSIDIAN_ARCHIVE=$taskArchive" >> $env:GITHUB_ENV
