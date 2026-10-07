param(
  [string]$AppPath = ""
)

$ErrorActionPreference = "Stop"

$repo = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repo)) {
  throw "Run this inside the xr-experiments repository."
}

if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path $repo "apps\weather-room"
}
$app = (Resolve-Path $AppPath).Path
$source = Join-Path $app ".agents\skills"

if (-not (Test-Path $source)) {
  throw "No Meta-generated Agent Skills found at '$source'. Scaffold the app with the current @iwsdk/create output first (see root AGENTS.md)."
}

$skills = @(Get-ChildItem $source -Directory | Where-Object { $_.Name -like "iwsdk-*" })
if ($skills.Count -eq 0) {
  throw "The generated .agents/skills directory at '$source' contains no iwsdk-* skills."
}

# OMP discovers skills from .agents/skills via project walk-up, and
# .omp/agents/*.md autoloadSkills resolve against the same registry. Keep both
# roots in sync with the complete official files, never compressed summaries.
$destRoots = @(
  (Join-Path $repo ".agents\skills"),
  (Join-Path $repo ".omp\skills")
)

foreach ($destRoot in $destRoots) {
  New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
  foreach ($skill in $skills) {
    $target = Join-Path $destRoot $skill.Name
    if (Test-Path $target) {
      Remove-Item -Recurse -Force $target
    }
    Copy-Item -Recurse -Force $skill.FullName $target
  }
  $copied = @(Get-ChildItem $destRoot -Directory | Where-Object { $_.Name -like "iwsdk-*" })
  if ($copied.Count -ne $skills.Count) {
    throw "Skill sync verification failed for '$destRoot': expected $($skills.Count), found $($copied.Count)."
  }
  $missingNames = @()
  foreach ($skill in $skills) {
    if (-not (Test-Path (Join-Path $destRoot ($skill.Name + "\SKILL.md")))) {
      $missingNames += $skill.Name
    }
  }
  if ($missingNames.Count -gt 0) {
    throw ("Skill sync verification failed for '" + $destRoot + "': missing SKILL.md in: " + ($missingNames -join ", ") + ".")
  }
  Write-Host "Synced $($skills.Count) official Meta IWSDK skills to $destRoot"
}
