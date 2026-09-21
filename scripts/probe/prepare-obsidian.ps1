$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (!$env:GITHUB_WORKSPACE -or !$env:GITHUB_ENV) {
  throw 'Obsidian preparation requires GITHUB_WORKSPACE and GITHUB_ENV.'
}
$taskCache = Join-Path $env:GITHUB_WORKSPACE '.cache/obsidian/1.13.7'
$taskRuntime = Join-Path $env:GITHUB_WORKSPACE '.test-runtime'
New-Item -ItemType Directory -Force -Path $taskCache, $taskRuntime | Out-Null
$taskAssets = @{
  'Obsidian-1.13.7.exe' = 'f233dc24896b3f2d5f9e4b01111181a561d0760b2105f0a474024c5f3143a9bc'
  'obsidian-1.13.7.asar.gz' = '69253e39aa0b980e3cf96e9e8a8a4bed6b6481ef7021cd762f67872662d8d25a'
}
foreach ($taskAsset in $taskAssets.GetEnumerator()) {
  $taskPath = Join-Path $taskCache $taskAsset.Key
  if (!(Test-Path -LiteralPath $taskPath) -or (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    Invoke-WebRequest -Uri "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7/$($taskAsset.Key)" -OutFile $taskPath
  }
  if ((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskAsset.Value) {
    throw "Obsidian asset checksum mismatch: $($taskAsset.Key)"
  }
}
$taskInstall = Join-Path $taskRuntime 'obsidian-install'
$taskInstaller = Start-Process -FilePath (Join-Path $taskCache 'Obsidian-1.13.7.exe') -ArgumentList '/S', "/D=$taskInstall" -WindowStyle Hidden -Wait -PassThru
if ($taskInstaller.ExitCode -ne 0) { throw "Obsidian installer failed: $($taskInstaller.ExitCode)" }
$taskExecutable = Join-Path $taskInstall 'Obsidian.exe'
if (!(Test-Path -LiteralPath $taskExecutable)) { throw 'Obsidian executable is missing.' }
$taskArchive = Join-Path $taskRuntime 'obsidian-1.13.7.asar'
$taskInput = [IO.Compression.GZipStream]::new([IO.File]::OpenRead((Join-Path $taskCache 'obsidian-1.13.7.asar.gz')), [IO.Compression.CompressionMode]::Decompress)
try {
  $taskOutput = [IO.File]::Create($taskArchive)
  try { $taskInput.CopyTo($taskOutput) } finally { $taskOutput.Dispose() }
} finally { $taskInput.Dispose() }
"OBSIDIAN_EXECUTABLE=$taskExecutable" >> $env:GITHUB_ENV
"OBSIDIAN_ARCHIVE=$taskArchive" >> $env:GITHUB_ENV
