$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (!$env:GITHUB_WORKSPACE -or !$env:GITHUB_ENV) {
  throw 'Obsidian preparation requires GITHUB_WORKSPACE and GITHUB_ENV.'
}
$taskCache = Join-Path $env:GITHUB_WORKSPACE '.cache/obsidian/1.14.4'
$taskRuntime = Join-Path $env:GITHUB_WORKSPACE '.test-runtime'
New-Item -ItemType Directory -Force -Path $taskCache, $taskRuntime | Out-Null
$taskAssets = @{
  'Obsidian-1.14.4.exe' = '28662520368d5956df7798076b8370ac730164a8863dcd4f678ced53f63faa00'
  'obsidian-1.14.4.asar.gz' = 'd1ed428c363968774f0f3906e67d8a53a058ece0b6cdd924b07865977b2ada21'
}
foreach ($taskAsset in $taskAssets.GetEnumerator()) {
  $taskPath = Join-Path $taskCache $taskAsset.Key
  if (!(Test-Path -LiteralPath $taskPath) -or (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    Invoke-WebRequest -Uri "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/$($taskAsset.Key)" -OutFile $taskPath
  }
  if ((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    throw "Obsidian asset checksum mismatch: $($taskAsset.Key)"
  }
}
$taskInstall = Join-Path $taskRuntime 'obsidian-install'
$taskInstaller = Start-Process -FilePath (Join-Path $taskCache 'Obsidian-1.14.4.exe') -ArgumentList '/S', "/D=$taskInstall" -WindowStyle Hidden -Wait -PassThru
if ($taskInstaller.ExitCode -ne 0) { throw "Obsidian installer failed: $($taskInstaller.ExitCode)" }
$taskExecutable = Join-Path $taskInstall 'Obsidian.exe'
if (!(Test-Path -LiteralPath $taskExecutable)) { throw 'Obsidian executable is missing.' }
$taskArchive = Join-Path $taskRuntime 'obsidian-1.14.4.asar'
$taskInput = [IO.Compression.GZipStream]::new([IO.File]::OpenRead((Join-Path $taskCache 'obsidian-1.14.4.asar.gz')), [IO.Compression.CompressionMode]::Decompress)
try {
  $taskOutput = [IO.File]::Create($taskArchive)
  try { $taskInput.CopyTo($taskOutput) } finally { $taskOutput.Dispose() }
} finally { $taskInput.Dispose() }
"OBSIDIAN_EXECUTABLE=$taskExecutable" >> $env:GITHUB_ENV
"OBSIDIAN_ARCHIVE=$taskArchive" >> $env:GITHUB_ENV
