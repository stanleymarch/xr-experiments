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
  # Skills are local tooling, not application source. A clean clone restores
  # the matching official files without scaffolding over the real app.
  $package = Get-Content (Join-Path $app "package.json") -Raw | ConvertFrom-Json
  $sdkVersion = $package.dependencies.'@iwsdk/core'
  $temporaryApp = Join-Path $repo (".tmp\iwsdk-skills-" + [Guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Force $temporaryApp | Out-Null
    Push-Location $temporaryApp
    try {
      & npx --yes "@iwsdk/create@$sdkVersion" . --yes --target ar --no-install --no-git --skip-reference-warmup
    } finally {
      Pop-Location
    }
    if ($LASTEXITCODE -ne 0) { throw "Official IWSDK skill generation failed." }
    $generated = Join-Path $temporaryApp ".agents\skills"
    if (-not (Test-Path $generated)) { throw "Official creator produced no Agent Skills." }
    New-Item -ItemType Directory -Force (Split-Path $source -Parent) | Out-Null
    Copy-Item -Recurse -Force $generated $source
  } finally {
    if (Test-Path $temporaryApp) { Remove-Item -Recurse -Force $temporaryApp }
  }
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
