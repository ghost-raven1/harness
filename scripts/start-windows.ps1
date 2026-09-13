$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# Выбирает нативную сборку, в том числе при запуске x64 PowerShell на ARM.
$version = (Get-Content -LiteralPath (Join-Path $root '.nvmrc') -Raw).Trim()
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$nodeArch = if ($architecture -eq 'ARM64') { 'arm64' } elseif ($architecture -eq 'AMD64') { 'x64' } else { throw 'Нужна 64-разрядная Windows (x64 или ARM64).' }
$release = "node-v$version-win-$nodeArch"
$runtime = Join-Path $root ".tools\$release\node.exe"
$npm = Join-Path $root ".tools\$release\node_modules\npm\bin\npm-cli.js"
# Повреждённый кэш должен восстанавливаться так же, как отсутствующий runtime.
function Test-HarnessRuntime {
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -or -not (Test-Path -LiteralPath $npm -PathType Leaf)) { return $false }
  try {
    $actual = & $runtime --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $actual -ne "v$version") { return $false }
    $npmVersion = & $runtime $npm --version 2>$null
    return ($LASTEXITCODE -eq 0 -and $npmVersion -match '^11\.')
  } catch { return $false }
}
try {
  if (-not (Test-HarnessRuntime)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $download = Join-Path $root ('.tools\runtime-download-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $download -Force | Out-Null
    try {
      Write-Host "Первый запуск: загружаю Node.js $version с nodejs.org…"
      $url = "https://nodejs.org/download/release/v$version"
      $checks = Invoke-WebRequest -UseBasicParsing -Uri "$url/SHASUMS256.txt" -TimeoutSec 60
      $archive = Join-Path $download "$release.zip"
      Invoke-WebRequest -UseBasicParsing -Uri "$url/$release.zip" -OutFile $archive -TimeoutSec 600
      $line = ($checks.Content -split "`n" | Where-Object { $_.Trim().EndsWith(" $release.zip") })
      if (-not $line) { throw 'Контрольная сумма не найдена.' }
      $expected = ($line.Trim() -split '\s+')[0]
      if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Проверка загрузки не прошла. Повторите запуск.' }
      Expand-Archive -LiteralPath $archive -DestinationPath $download
      $staged = Join-Path $download $release
      & (Join-Path $staged 'node.exe') (Join-Path $root 'scripts\install-runtime.mjs') $staged $release
      if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить локальный Node.js. Подробности указаны выше.' }
    } finally { Remove-Item -LiteralPath $download -Recurse -Force }
  }
  & $runtime (Join-Path $root 'scripts\bootstrap.mjs') @args
  exit $LASTEXITCODE
} catch {
  Write-Host ('Не удалось открыть Harness: ' + $_.Exception.Message)
  exit 1
}
