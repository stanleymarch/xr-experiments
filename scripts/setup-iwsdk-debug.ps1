param(
  [string]$AppPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Say([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

# Derive the repository root from this script's location so `npm run setup`
# works regardless of the caller's cwd.
$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path $repo "apps\weather-room"
}

Say "Syncing official Meta IWSDK skills"
Push-Location $repo
try {
  & (Join-Path $repo "scripts\sync-iwsdk-skills.ps1") -AppPath $AppPath
  if ($LASTEXITCODE -ne 0) { throw "Skill sync failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

Say "Verifying official IWSDK adapter state"
Push-Location $AppPath
try {
  & node "node_modules\@iwsdk\cli\dist\cli.js" adapter status
  if ($LASTEXITCODE -ne 0) { throw "IWSDK adapter status failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

Say "Ensuring official Android platform-tools for Quest debugging"
$adbExe = Join-Path $repo "tools\platform-tools\adb.exe"
if (-not (Test-Path $adbExe)) {
  $zip = Join-Path $repo "tools\platform-tools-latest-windows.zip"
  New-Item -ItemType Directory -Force -Path (Join-Path $repo "tools") | Out-Null
  Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath (Join-Path $repo "tools") -Force
  Remove-Item -Force $zip
}
& $adbExe --version
if ($LASTEXITCODE -ne 0) { throw "adb --version failed with exit code $LASTEXITCODE." }
Write-Host "Quest serials: & `"$adbExe`" devices -l"

Write-Host ""
Write-Host "Debug setup complete." -ForegroundColor Green
