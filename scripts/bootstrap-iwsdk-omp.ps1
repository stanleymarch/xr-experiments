param(
  [switch]$NoLaunch,
  [switch]$SkipScaffold
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$NL = [Environment]::NewLine

function Say([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Need([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing '$Name'. $Hint"
  }
}

function First-NonEmpty([object[]]$Values) {
  foreach ($v in $Values) {
    if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) {
      return [string]$v
    }
  }
  return $null
}

function Get-OmpModels([string]$Needle) {
  try {
    $raw = (& omp models find $Needle --json 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $parsed = $raw | ConvertFrom-Json
    return @($parsed.models)
  } catch {
    return @()
  }
}

function Pick-OmpModel {
  param(
    [string]$Needle,
    [string]$Provider,
    [string[]]$IdPatterns,
    [switch]$RequireImage
  )

  $models = @(Get-OmpModels $Needle | Where-Object { $_.provider -eq $Provider })

  if ($RequireImage) {
    $models = @($models | Where-Object {
      $inputs = @($_.input)
      $inputs -contains "image"
    })
  }

  foreach ($pattern in $IdPatterns) {
    $match = $models |
      Where-Object { $_.id -like $pattern } |
      Sort-Object id -Descending |
      Select-Object -First 1

    if ($null -ne $match) {
      if ($match.selector) { return [string]$match.selector }
      return "$($match.provider)/$($match.id)"
    }
  }

  if ($models.Count -gt 0) {
    $match = $models | Sort-Object id -Descending | Select-Object -First 1
    if ($match.selector) { return [string]$match.selector }
    return "$($match.provider)/$($match.id)"
  }

  return $null
}

function With-Effort([string]$Selector, [string]$Effort) {
  if ([string]::IsNullOrWhiteSpace($Selector)) { return $null }
  return "$($Selector):$Effort"
}

function Base-Selector([string]$Selector) {
  if ([string]::IsNullOrWhiteSpace($Selector)) { return "" }
  return ($Selector -replace ':(minimal|low|medium|high|xhigh|max)$','')
}

function Unique-Fallbacks([string]$Primary, [object[]]$Candidates) {
  $seen = @{}
  $primaryBase = Base-Selector $Primary
  $result = @()

  foreach ($candidate in $Candidates) {
    if ($null -eq $candidate) { continue }
    $s = [string]$candidate
    if ([string]::IsNullOrWhiteSpace($s)) { continue }
    $base = Base-Selector $s
    if ($base -eq $primaryBase) { continue }
    if (-not $seen.ContainsKey($base)) {
      $seen[$base] = $true
      $result += $s
    }
  }
  return $result
}

function Yaml-Quoted([string]$s) {
  if ($null -eq $s) { return '""' }
  return '"' + ($s -replace '"','\"') + '"'
}

function Yaml-List([object[]]$Items, [int]$Indent = 6) {
  $pad = " " * $Indent
  if ($null -eq $Items -or @($Items).Count -eq 0) {
    return "$($pad)[]"
  }
  return (@($Items) | ForEach-Object { "$($pad)- $(Yaml-Quoted ([string]$_))" }) -join $NL
}

Need git "Run this from inside the xr-experiments Git repository."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "Node.js is missing; installing current LTS for Meta IWSDK"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node.js is missing and winget is unavailable. Install a supported Node.js LTS, then rerun this script."
  }

  & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Automatic Node.js LTS installation failed. Install Node.js LTS with winget, then rerun."
  }

  # winget/MSI updates the persistent PATH, but this PowerShell process keeps
  # its old environment. Refresh it so bootstrap can continue immediately.
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js installed successfully but is not visible in this process. Open a new terminal and rerun the bootstrap."
  }
}

Need npm "Node/npm is required by Meta IWSDK."
Need npx "npx is required by Meta IWSDK."
Need omp "Install/update Oh My Pi first."

$repo = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repo)) {
  throw "Could not resolve Git repository root."
}
Set-Location $repo

Say "Checking Node.js for Meta IWSDK"
$nodeVersion = (& node -p "process.versions.node").Trim()
$parts = $nodeVersion.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
$nodeOk = (($major -eq 20 -and $minor -ge 19) -or ($major -eq 22 -and $minor -ge 12) -or ($major -eq 24))
if (-not $nodeOk) {
  throw "Node $nodeVersion is not in IWSDK 0.4.x supported ranges. Use Node >=20.19 <21, >=22.12 <23, or 24.x, then rerun this script."
}
Write-Host "Node $nodeVersion OK"

Say "Refreshing OMP model catalog"
try {
  & omp models refresh | Out-Host
} catch {
  Write-Warning "Model refresh failed; using the currently cached OMP catalog."
}

Say "Detecting models from YOUR OMP catalog"

$sol = Pick-OmpModel "gpt-6.1-sol" "openai-codex" @("gpt-6.1-sol*")
if (-not $sol) {
  $sol = Pick-OmpModel "sol" "openai-codex" @("gpt-6.1-sol*","gpt-5.6-sol*")
}

$luna = Pick-OmpModel "luna" "openai-codex" @("gpt-6-luna*","gpt-5.6-luna*")

$zaiGlm = Pick-OmpModel "glm-5.3" "zai" @("glm-5.3")
if (-not $zaiGlm) {
  $zaiGlm = Pick-OmpModel "glm" "zai" @("glm-5.3","glm-5.2*","glm-5*")
}

$deepseek = Pick-OmpModel "deepseek-v4.1-flash" "opencode-go" @("deepseek-v4.1-flash*")
if (-not $deepseek) {
  $deepseek = Pick-OmpModel "deepseek" "opencode-go" @("*v4.1*flash*","*flash*")
}

$muse = Pick-OmpModel "muse-spark" "opencode-go" @("*contributor*","muse-spark*")

# DESIGNER is intentionally pinned, not auto-selected. OpenCode Go's canonical
# current model id is opencode-go/kimi-k3. Do not silently replace the design
# reviewer with Sol/GLM/Muse if catalog discovery behaves differently.
$kimi = "opencode-go/kimi-k3"

$museVision = Pick-OmpModel "muse-spark" "opencode-go" @("*contributor*","muse-spark*") -RequireImage
$zaiVision = Pick-OmpModel "glm" "zai" @("glm-5.3-flash*","glm-5v-turbo*","*vision*") -RequireImage
$deepseekVision = Pick-OmpModel "deepseek" "opencode-go" @("*v4.1*flash*","*vision*") -RequireImage
$kimiVision = Pick-OmpModel "kimi-k3" "opencode-go" @("kimi-k3*","*kimi*k3*") -RequireImage

$defaultBase = First-NonEmpty @($zaiGlm, $luna, $deepseek, $muse, $sol)
$taskBase = First-NonEmpty @($muse, $deepseek, $luna, $zaiGlm, $sol)
$tinyBase = First-NonEmpty @($muse, $deepseek, $luna, $zaiGlm, $sol)
$planBase = First-NonEmpty @($sol, $zaiGlm, $deepseek, $muse, $luna)
$advisorBase = First-NonEmpty @($sol, $zaiGlm, $deepseek, $muse, $luna)
$visionBase = First-NonEmpty @($museVision, $zaiVision, $deepseekVision, $kimiVision)
$designerBase = $kimi

if (-not $defaultBase -or -not $taskBase -or -not $planBase) {
  throw "Could not resolve enough models from OMP. Make sure Codex, Z.AI and/or OpenCode Go are logged in, then run 'omp models --kind all'."
}

$default = if ($zaiGlm -and $defaultBase -eq $zaiGlm) { With-Effort $defaultBase "high" } else { $defaultBase }
$task = $taskBase
$smol = $taskBase
$tiny = $tinyBase
$memory = $tinyBase
$commit = $tinyBase
$plan = if ($sol -and $planBase -eq $sol) { With-Effort $planBase "xhigh" } elseif ($zaiGlm -and $planBase -eq $zaiGlm) { With-Effort $planBase "max" } else { $planBase }
$slow = $plan
$advisor = if ($sol -and $advisorBase -eq $sol) { With-Effort $advisorBase "high" } elseif ($zaiGlm -and $advisorBase -eq $zaiGlm) { With-Effort $advisorBase "max" } else { $advisorBase }
$vision = $visionBase
$designer = "opencode-go/kimi-k3"

$planGlmFallback = if ($zaiGlm) { With-Effort $zaiGlm "max" } else { $null }
$advisorGlmFallback = if ($zaiGlm) { With-Effort $zaiGlm "max" } else { $null }
$designerSolFallback = if ($sol) { With-Effort $sol "high" } else { $null }
$designerGlmFallback = if ($zaiGlm) { With-Effort $zaiGlm "high" } else { $null }

$chains = @{
  default  = Unique-Fallbacks $default  @($luna, $deepseek, $muse, $sol)
  task     = Unique-Fallbacks $task     @($luna, $zaiGlm, $deepseek, $sol)
  smol     = Unique-Fallbacks $smol     @($luna, $zaiGlm, $deepseek)
  tiny     = Unique-Fallbacks $tiny     @($luna, $zaiGlm, $deepseek)
  memory   = Unique-Fallbacks $memory   @($luna, $zaiGlm, $deepseek)
  commit   = Unique-Fallbacks $commit   @($luna, $zaiGlm, $deepseek)
  plan     = Unique-Fallbacks $plan     @($planGlmFallback, $deepseek, $muse, $luna)
  slow     = Unique-Fallbacks $slow     @($planGlmFallback, $deepseek, $muse, $luna)
  advisor  = Unique-Fallbacks $advisor  @($advisorGlmFallback, $deepseek, $muse, $luna)
  vision   = Unique-Fallbacks $vision   @($zaiVision, $deepseekVision, $kimiVision, $museVision)
  designer = Unique-Fallbacks $designer @($designerSolFallback, $designerGlmFallback, $muse, $deepseek)
}

Write-Host ""
Write-Host "Resolved routing:" -ForegroundColor Green
Write-Host "  DEFAULT  -> $default"
Write-Host "  TASK     -> $task"
Write-Host "  SMOL     -> $smol"
Write-Host "  TINY     -> $tiny"
Write-Host "  MEMORY   -> $memory"
Write-Host "  PLAN     -> $plan"
Write-Host "  SLOW     -> $slow"
Write-Host "  ADVISOR  -> $advisor"
Write-Host "  VISION   -> $vision"
Write-Host "  DESIGNER -> $designer"

$ompDir = Join-Path $repo ".omp"
$agentsDir = Join-Path $ompDir "agents"
$skillsDir = Join-Path $ompDir "skills"
$promptsDir = Join-Path $ompDir "prompts"
New-Item -ItemType Directory -Force -Path $ompDir,$agentsDir,$skillsDir,$promptsDir | Out-Null

$visionRoleLine = if ($vision) { "  vision: $(Yaml-Quoted $vision)" } else { "" }
$designerRoleLine = if ($designer) { "  designer: $(Yaml-Quoted $designer)" } else { "" }
$visionFallbackBlock = if ($vision) { "    vision:$NL$(Yaml-List $chains.vision)" } else { "" }
$designerFallbackBlock = if ($designer) { "    designer:$NL$(Yaml-List $chains.designer)" } else { "" }

$config = @"
modelRoleStorage: project

modelRoles:
  default: $(Yaml-Quoted $default)
  task: $(Yaml-Quoted $task)
  smol: $(Yaml-Quoted $smol)
  tiny: $(Yaml-Quoted $tiny)
  memory: $(Yaml-Quoted $memory)
  commit: $(Yaml-Quoted $commit)
  plan: $(Yaml-Quoted $plan)
  slow: $(Yaml-Quoted $slow)
  advisor: $(Yaml-Quoted $advisor)
$visionRoleLine
$designerRoleLine

retry:
  enabled: true
  maxRetries: 4
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    default:
$(Yaml-List $chains.default)
    task:
$(Yaml-List $chains.task)
    smol:
$(Yaml-List $chains.smol)
    tiny:
$(Yaml-List $chains.tiny)
    memory:
$(Yaml-List $chains.memory)
    commit:
$(Yaml-List $chains.commit)
    plan:
$(Yaml-List $chains.plan)
    slow:
$(Yaml-List $chains.slow)
    advisor:
$(Yaml-List $chains.advisor)
$visionFallbackBlock
$designerFallbackBlock
"@

Set-Content -Path (Join-Path $ompDir "config.yml") -Value $config -Encoding UTF8

$rules = @'
# XR Experiments — non-negotiable project rules

- New Meta/Android XR work uses Meta Immersive Web SDK (IWSDK) under 'apps/'.
- Google XR Blocks is dead. Never restore, inspect through Git history, copy, or use its implementation unless the user explicitly asks to recover history.
- Preserve XR Blocks concepts only through 'MIGRATION.md'. Every IWSDK implementation is greenfield.
- '8thwall/' is NOT legacy. It is active supported iPhone/iPad WebAR code. Never delete, mass-migrate, or rewrite it merely because IWSDK is preferred elsewhere.
- Quest 3 / supported Android WebXR => IWSDK. iPhone/iPad WebAR => existing 8th Wall implementation when needed.
- A concept may have separate IWSDK and 8th Wall frontends. Share framework-neutral TypeScript logic only when there are two real consumers.
- Existing 8th Wall experiences such as Battleship stay working. An IWSDK counterpart is a separate deliberate task, never an automatic migration.
- Use official scoped packages '@iwsdk/create' and '@iwsdk/cli'.
- CLI-first: use 'npx @iwsdk/cli ...' for reference lookup, managed runtime/IWER, screenshots, logs, scene/ECS inspection, and verification.
- Never invent IWSDK APIs from memory. Query the local IWSDK reference corpus first.
- Before declaring an IWSDK feature complete: build, run managed runtime, enter IWER XR, exercise the interaction, inspect logs/runtime state, and capture app-only screenshots.
- Quest 3 MR is primary. Android WebXR AR is secondary and degrades by capability detection.
- No PAYG coding-agent routing. Use configured subscription roles/fallbacks only.
- Contributor models may inspect public project source and app-only screenshots, never secrets, tokens, SSH material, private URLs, personal files, or full-desktop screenshots.
- 'designer' is for milestone spatial/game/visual critique. 'iwsdk-reviewer' is for technical correctness. 'iwsdk-builder' is the normal implementation worker.
'@
Set-Content -Path (Join-Path $ompDir "RULES.md") -Value $rules -Encoding UTF8

$agentsContext = @'
# OMP project context: Meta Immersive Web SDK migration

We are rebuilding the experimental XR experiences from scratch on Meta Immersive Web SDK.

Target experiences:
1. WEATHER//ROOM
2. REALITY//FIELD
3. CITY//ORBIT
4. SOUND//SPACE
5. ECHO//ROOM

Google XR Blocks source is intentionally removed from the working tree. Use MIGRATION.md for concepts only; never inspect Git history to recover implementation details.

The '8thwall/' directory is active supported code for iPhone/iPad WebAR. Preserve it. Do not automatically migrate it to IWSDK.

When creating a new IWSDK app:
1. Use the official '@iwsdk/create@latest'.
2. Generate Codex AI-tool files so the canonical Meta IWSDK skills are emitted.
3. Run 'npx @iwsdk/cli adapter sync'.
4. Run 'npx @iwsdk/cli reference warmup' and verify 'reference status'.
5. Copy/sync generated 'iwsdk-*' skills into repository '.omp/skills/' so OMP launched at repository root can autoload them.
6. Prefer the Meta CLI/reference corpus over web guesses.
7. Use IWER and runtime inspection as part of development, not only after coding.

For WEATHER//ROOM the primary technical goal is: physical-room-aware weather in Quest 3 MR, with real scene surfaces, raycasts, physics where appropriate, depth occlusion where available, hand/controller interaction, Open-Meteo data, and capability-based Android AR degradation.
'@
Set-Content -Path (Join-Path $ompDir "AGENTS.md") -Value $agentsContext -Encoding UTF8

$designerAgent = @'
---
name: designer
description: Spatial XR art director and game-feel reviewer for playable IWSDK milestones.
model: "@designer"
autoloadSkills: [iwsdk-dev, iwsdk-ui, iwsdk-debug]
blocking: true
---

Review the current playable XR experience as a spatial designer and game designer, not as a routine programmer.

Inspect app-only screenshots/video/runtime state when available. Evaluate:
- spatial composition and scale;
- visual hierarchy and headset readability;
- affordances and discoverability;
- interaction feedback and game feel;
- pacing and moment-to-moment loop;
- whether XR is used meaningfully rather than as a flat UI in 3D;
- clarity on Quest passthrough;
- novelty, atmosphere, and the strongest "wow" moment;
- unnecessary visual noise or generic AI aesthetics.

Return a short prioritized set of concrete changes. Distinguish must-fix usability problems from optional art-direction experiments. Do not rewrite implementation unless explicitly asked.
'@
Set-Content -Path (Join-Path $agentsDir "designer.md") -Value $designerAgent -Encoding UTF8

$builderAgent = @'
---
name: iwsdk-builder
description: Implements and debugs Meta IWSDK experiences using official references and runtime verification.
model: "@task"
autoloadSkills: [iwsdk-dev, iwsdk-debug, iwsdk-physics, iwsdk-depth-occlusion, iwsdk-ray, iwsdk-ui]
advisor: true
---

Implement the assigned Meta Immersive Web SDK work.

Use official IWSDK skills and the local reference corpus before relying on memory. Do not invent API names. Prefer the official scaffold and built-in IWSDK systems over custom WebXR framework code.

Work to a runtime result:
1. inspect/reference;
2. implement;
3. build/typecheck;
4. start IWSDK managed runtime;
5. enter IWER XR where applicable;
6. exercise the important interaction;
7. inspect browser logs and ECS/scene state;
8. take app-only screenshots;
9. fix failures and repeat.

Do not claim Quest-only sensing, room geometry, depth or performance is verified unless it was tested on physical hardware.
'@
Set-Content -Path (Join-Path $agentsDir "iwsdk-builder.md") -Value $builderAgent -Encoding UTF8

$reviewerAgent = @'
---
name: iwsdk-reviewer
description: Senior technical reviewer for IWSDK architecture, API correctness, XR capability handling, physics and verification.
model: "@advisor"
autoloadSkills: [iwsdk-dev, iwsdk-debug, iwsdk-physics, iwsdk-depth-occlusion, iwsdk-ray, iwsdk-ui]
blocking: true
---

Review the implementation independently.

Check:
- IWSDK APIs and patterns against the installed reference corpus;
- accidental legacy XR Blocks / 8th Wall architecture;
- capability detection and Quest-vs-phone degradation;
- ECS/system ownership and lifecycle correctness;
- physics/scene-understanding/depth assumptions;
- interaction correctness for hands/controllers;
- runtime errors and unhandled permission/network paths;
- performance hazards relevant to standalone Quest;
- whether build-only claims are being mistaken for XR runtime verification.

Return prioritized findings with concrete fixes. Separate emulator-verifiable findings from hardware-only validation.
'@
Set-Content -Path (Join-Path $agentsDir "iwsdk-reviewer.md") -Value $reviewerAgent -Encoding UTF8

$weatherPrompt = @'
orchestrate

Implement WEATHER//ROOM as a completely new Meta Immersive Web SDK mixed-reality experience in 'apps/weather-room'.

The legacy 'xrblocks/weather-room' may be read only for the original idea, data mapping and art direction. Do not copy its code or architecture.

Before implementation:
- read the project '.omp/RULES.md' and '.omp/AGENTS.md';
- use the installed Meta IWSDK skills;
- query the local IWSDK reference corpus for APIs/patterns you will use;
- inspect the current official scaffold.

Primary target: Meta Quest 3 mixed reality.
Secondary target: supported Android WebXR AR with honest capability-based degradation.
Desktop/IWER: development and meaningful fallback.

Concept:
The real room becomes a physical embodiment of current/local weather using Open-Meteo. Wind, precipitation, cloud cover, temperature and pressure must visibly affect the spatial experience. Include a -24h / NOW / +24h timeline without refetching every frame.

Quest goals where current IWSDK/browser capabilities permit:
- scene understanding / real room surfaces;
- environment raycasts;
- depth occlusion;
- physical interactions/collisions with detected real surfaces where justified;
- hands and controllers;
- spatial UI that remains legible in passthrough.

Android goals:
- real camera AR when WebXR AR is supported;
- hit-test/placement/anchors/depth only when actually exposed;
- graceful fallback rather than pretending Quest room understanding exists.

Development contract:
- delegate routine implementation to 'iwsdk-builder';
- use 'iwsdk-reviewer' for an independent technical review before completion;
- once a coherent playable milestone exists, invoke 'designer' once for spatial/game/visual critique, then implement the high-value fixes;
- do not spend the designer model on routine coding;
- build and test repeatedly using IWSDK CLI/IWER;
- inspect console logs and runtime state;
- capture app-only screenshots;
- do not declare hardware-only behavior verified until physical Quest testing.

Finish with a concise report of implemented functionality, what was verified in IWER, what still needs a Quest 3 smoke test, and Android capability dependencies.
'@
Set-Content -Path (Join-Path $promptsDir "weather-room.md") -Value $weatherPrompt -Encoding UTF8

$syncScript = @'
param([Parameter(Mandatory=$true)][string]$AppPath)

$ErrorActionPreference = "Stop"
$repo = (& git rev-parse --show-toplevel).Trim()
$app = Resolve-Path $AppPath
$source = Join-Path $app ".codex\skills"
$dest = Join-Path $repo ".omp\skills"

if (-not (Test-Path $source)) {
  throw "No generated Codex skills found at $source. Scaffold the IWSDK app with --ai-tools codex."
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem $source -Directory | Where-Object { $_.Name -like "iwsdk-*" } | ForEach-Object {
  $target = Join-Path $dest $_.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse -Force $_.FullName $target
  Write-Host "Synced skill: $($_.Name)"
}
'@
Set-Content -Path (Join-Path $repo "scripts\sync-iwsdk-skills.ps1") -Value $syncScript -Encoding UTF8

Say "Removing Google XR Blocks implementation while preserving concepts only"
$migration = @'
# XR Blocks -> IWSDK greenfield concepts

The former Google XR Blocks implementations were intentionally removed. Do not recover old source from Git history when implementing these.

- WEATHER//ROOM — the physical room manifests local weather; Open-Meteo; wind, rain, cloudiness, temperature, pressure; -24h / NOW / +24h.
- REALITY//FIELD — physical room geometry behaves as a force field for particles/fragments.
- CITY//ORBIT — spatial/orbital city visualization from OSM/POIs with tabletop/360 interaction and hand scaling.
- SOUND//SPACE — microphone/FFT sound visualization with frozen sound sculptures.
- ECHO//ROOM — spatial memory / temporal debugger of recent interactions.

All five are greenfield Meta IWSDK experiences under apps/. Preserve ideas, not XR Blocks code or architecture.

8th Wall is intentionally excluded: 8thwall/ remains active iPhone/iPad WebAR code.
'@
Set-Content -Path (Join-Path $repo "MIGRATION.md") -Value $migration -Encoding UTF8

if (Test-Path (Join-Path $repo "xrblocks")) { Remove-Item -Recurse -Force (Join-Path $repo "xrblocks") }
if (Test-Path (Join-Path $repo "XR-BLOCKS.md")) { Remove-Item -Force (Join-Path $repo "XR-BLOCKS.md") }

$xbSkills = Join-Path $repo ".agents\\skills"
if (Test-Path $xbSkills) {
  Get-ChildItem $xbSkills -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "xb-*" } | Remove-Item -Recurse -Force
}

$rootAgents = @'
# XR Experiments

This repository is an XR experimentation monorepo.

- Meta IWSDK / Quest 3 / supported Android WebXR work lives in apps/.
- 8thwall/ is active supported iPhone/iPad WebAR code. Preserve it; do not automatically migrate or delete it.
- Google XR Blocks implementation has been intentionally removed. MIGRATION.md contains the only allowed conceptual reference for those experiments.
- Never inspect Git history to recover XR Blocks implementation unless the user explicitly asks.
- Project-specific OMP rules, agents, model routing and Meta IWSDK skills live in .omp/.
'@
Set-Content -Path (Join-Path $repo "AGENTS.md") -Value $rootAgents -Encoding UTF8

Say "Validating project-local OMP settings"
& omp config get modelRoles --json | Out-Host
& omp config get retry.fallbackChains --json | Out-Host

$appPath = Join-Path $repo "apps\weather-room"

if (-not $SkipScaffold) {
  if (-not (Test-Path $appPath)) {
    Say "Scaffolding WEATHER//ROOM with official Meta @iwsdk/create"
    New-Item -ItemType Directory -Force -Path (Split-Path $appPath -Parent) | Out-Null

    & npx --yes @iwsdk/create@latest $appPath --yes --target ar --physics --grabbing --scene-understanding --environment-raycast --language ts --ai-tools codex --no-git --install
    if ($LASTEXITCODE -ne 0) { throw "@iwsdk/create failed." }
  } else {
    Write-Host "apps/weather-room already exists; not overwriting it."
  }

  if (Test-Path (Join-Path $appPath "package.json")) {
    Push-Location $appPath
    try {
      Say "Syncing Meta IWSDK adapters"
      & npx @iwsdk/cli adapter sync
      if ($LASTEXITCODE -ne 0) { Write-Warning "adapter sync returned non-zero; OMP can still use CLI-first workflow." }

      Say "Warming local Meta IWSDK reference corpus"
      & npx @iwsdk/cli reference warmup
      if ($LASTEXITCODE -ne 0) { throw "IWSDK reference warmup failed." }

      & npx @iwsdk/cli reference status | Out-Host

      Say "Verifying fresh IWSDK app build"
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "Fresh IWSDK app build failed." }
    } finally {
      Pop-Location
    }

    Say "Syncing generated Meta IWSDK skills into root .omp/skills"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\sync-iwsdk-skills.ps1") -AppPath $appPath
  }
}

Write-Host ""
Write-Host "Bootstrap complete." -ForegroundColor Green
Write-Host "Project OMP config: .omp/config.yml"
Write-Host "Meta rules:         .omp/RULES.md"
Write-Host "Agents:             .omp/agents/"
Write-Host "IWSDK skills:       .omp/skills/"
Write-Host "Weather prompt:     .omp/prompts/weather-room.md"
Write-Host ""
Write-Host "No PAYG provider was configured. Model selectors came from your local OMP catalog."

if (-not $NoLaunch) {
  Say "Launching OMP with WEATHER//ROOM task"
  $prompt = Get-Content (Join-Path $promptsDir "weather-room.md") -Raw
  & omp $prompt
}
