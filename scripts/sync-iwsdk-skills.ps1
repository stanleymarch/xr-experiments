param(
  [Parameter(Mandatory=$true)]
  [string]$AppPath
)

$ErrorActionPreference = "Stop"

$repo = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repo)) {
  throw "Run this inside the xr-experiments repository."
}

$app = (Resolve-Path $AppPath).Path
$source = Join-Path $app ".agents\skills"
$dest = Join-Path $repo ".omp\skills"

if (-not (Test-Path $source)) {
  throw "No Meta-generated Agent Skills found at '$source'. Inspect the current @iwsdk/create output before assuming another path."
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null

$skills = @(Get-ChildItem $source -Directory | Where-Object { $_.Name -like "iwsdk-*" })
if ($skills.Count -eq 0) {
  throw "The generated .agents/skills directory contains no iwsdk-* skills."
}

foreach ($skill in $skills) {
  $target = Join-Path $dest $skill.Name
  if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
  }
  Copy-Item -Recurse -Force $skill.FullName $target
  Write-Host "Synced Meta IWSDK skill: $($skill.Name)"
}
