param(
  [switch]$NoLaunch
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

function Refresh-ProcessPath {
  # A terminal opened before an MSI/winget install can have a stale PATH.
  # Preserve session-only entries while importing the current persistent PATH.
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($machinePath, $userPath, $env:Path)

  # Node's Windows MSI normally installs here. Add it explicitly as a recovery
  # path because Windows PowerShell -NoProfile can otherwise miss a fresh install.
  $nodeCandidates = @((Join-Path $env:ProgramFiles "nodejs"))
  if (${env:ProgramFiles(x86)}) {
    $nodeCandidates += Join-Path ${env:ProgramFiles(x86)} "nodejs"
  }
  if ($env:LOCALAPPDATA) {
    $nodeCandidates += Join-Path $env:LOCALAPPDATA "Programs\\nodejs"
  }
  foreach ($candidate in $nodeCandidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate "node.exe"))) {
      $parts += $candidate
    }
  }

  $env:Path = (@($parts) |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
    ForEach-Object { [string]$_ } |
    Select-Object -Unique) -join ";"
}

# Refresh first: Node may already be installed but invisible to this child shell.
Refresh-ProcessPath

# A nested Windows PowerShell can inherit a stale PATH even when Node is already
# installed. Recover common Node installation directories before touching winget.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $nodeCandidates = @(
    (Join-Path $env:ProgramFiles "nodejs"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "nodejs" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\\nodejs" }),
    $(if ($env:APPDATA) { Join-Path $env:APPDATA "npm" })
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($dir in $nodeCandidates) {
    if ($env:Path -notlike "*$dir*") { $env:Path = "$dir;$env:Path" }
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "Node.js is not visible; refreshing Windows PATH"
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath;$env:Path"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "Node.js is genuinely missing; installing current LTS for Meta IWSDK"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node.js is missing and winget is unavailable. Install Node.js LTS, then rerun this script."
  }

  & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  $wingetExit = $LASTEXITCODE

  # winget returns a non-zero code in some 'already installed/no upgrade'
  # situations. Do not treat that message as fatal until Node discovery is
  # retried against the persistent environment and standard install paths.
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath;$env:Path"
  $programFilesNode = Join-Path $env:ProgramFiles "nodejs"
  if (Test-Path $programFilesNode) { $env:Path = "$programFilesNode;$env:Path" }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is still unavailable after winget (exit $wingetExit). Open a new terminal and rerun the bootstrap; if 'node --version' still fails there, repair the Node.js installation."
  }
}

$resolvedNode = (Get-Command node -ErrorAction Stop).Source
Write-Host "Using Node: $resolvedNode ($(& node --version))"

Need npm "Node is visible, but npm is not. Close this terminal, open a new one, and rerun."
Need npx "Node is visible, but npx is not. Close this terminal, open a new one, and rerun."
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
  throw "Node $nodeVersion is not in the supported IWSDK ranges. Use Node >=20.19 <21, >=22.12 <23, or 24.x, then rerun this script."
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
  usageAwareFallback: true
  usageReservePct: 5
  usageReservePolicy: auto
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
# OMP project context: autonomous XR repository manager

You are the lead engineer/orchestrator for this repository. The bootstrap only prepares OMP configuration and this brief. You own repository migration, current IWSDK CLI discovery, scaffolding, implementation, testing, review delegation, and the final commit-ready state.

## Repository policy

Desired architecture:

- apps/ — fresh Meta Immersive Web SDK experiences for Quest 3 and supported Android WebXR.
- 8thwall/ — active iPhone/iPad WebAR implementations. Preserve them.
- .omp/ — project-local OMP config, agents, prompts, and synced IWSDK skills.
- MIGRATION.md — concepts preserved from former XR Blocks experiments.
- AGENTS.md — concise repository-wide rules.

Google XR Blocks is retired. Remove its working-tree implementation and support files, but preserve the concepts listed below. Do not inspect Git history to recover XR Blocks code.

Remove when present:
- xrblocks/
- XR-BLOCKS.md
- .agents/skills/xb-*
- obsolete XR Blocks-only install/sync hooks or build logic that remains anywhere else

Do NOT remove or mass-migrate:
- 8thwall/
- existing working 8th Wall Battleship/Sea Battle
- generic repo tooling still used by active projects

Before deleting or editing shared root files, inspect them and preserve anything still required by 8thwall/.

## IWSDK operating procedure

For every new IWSDK app:
1. Inspect the CURRENT installed/latest '@iwsdk/create --help' instead of assuming old flags.
2. Scaffold with the official Meta creator using the current supported interface.
3. Inspect the generated AGENTS.md, .agents/skills, adapter files and iwsdk.config.json.
4. Run 'npx @iwsdk/cli adapter sync' if applicable.
5. Warm/check the local reference corpus with 'npx @iwsdk/cli reference warmup' and 'reference status'.
6. Sync generated '.agents/skills/iwsdk-*' into repository '.omp/skills/' using scripts/sync-iwsdk-skills.ps1, or update that helper if Meta changed the generated location.
7. Use local Meta references/skills before relying on remembered IWSDK APIs.
8. Build/typecheck and use the managed runtime/IWER. Inspect logs, scene/ECS/runtime state and app-only screenshots.
9. Never claim Quest-only sensing, room geometry, depth, hand tracking or performance was physically verified unless tested on Quest hardware.

## Concepts retained from XR Blocks

1. WEATHER//ROOM — physical room manifests local weather; Open-Meteo; wind, rain, cloudiness, temperature, pressure; timeline -24h / NOW / +24h.
2. REALITY//FIELD — room geometry behaves as a force field for particles/fragments.
3. CITY//ORBIT — OSM/POI spatial/orbital city visualization; tabletop/360; hand scaling.
4. SOUND//SPACE — microphone/FFT visualization; freeze sound sculptures.
5. ECHO//ROOM — spatial memory / temporal debugger of recent interactions.

All five future IWSDK implementations are greenfield. Preserve ideas, not old code.

## Delegation policy

- Normal implementation: delegate substantial bounded work to 'iwsdk-builder'.
- Architecture/API/runtime correctness review: 'iwsdk-reviewer' using @advisor.
- Spatial/game/visual milestone review: 'designer' using @designer (Kimi K3 primary).
- Keep the lead/orchestrator responsible for sequencing, integration, verification and fixing review findings.
- Do not spend reviewer/designer models on routine edits.
- No PAYG providers.
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

Act as the autonomous lead for the xr-experiments repository and carry the task through to a clean, buildable, commit-ready state. Do not ask the user to manually run IWSDK setup commands that you can discover and execute yourself.

# Phase 0 — inspect before changing

Read:
- .omp/RULES.md
- .omp/AGENTS.md
- current root AGENTS.md, package.json, scripts/, .gitignore
- active 8thwall/ structure and its root build dependencies

Check git status first. Do not destroy unrelated user changes. If there are pre-existing edits you cannot safely distinguish from bootstrap output, preserve them and work around them.

Inspect the CURRENT official Meta CLI rather than assuming syntax:
- node --version
- npm --version
- npx --yes @iwsdk/create@latest --help
- after scaffolding, inspect local @iwsdk/cli help/reference capabilities

# Phase 1 — manage/migrate the repository

Target layout:
- apps/weather-room/ — new greenfield Meta IWSDK app
- 8thwall/ — preserved active iPhone/iPad WebAR code
- .omp/ — project-local OMP setup
- MIGRATION.md — concept-only record of retired XR Blocks work
- AGENTS.md — repo-wide architecture rules

Retire Google XR Blocks from the WORKING TREE. Remove when present:
- xrblocks/
- XR-BLOCKS.md
- .agents/skills/xb-*
- scripts/install-xrblocks-skills.mjs
- root package.json hooks/scripts/dependencies that exist only to install/sync/build XR Blocks
- XR Blocks branches in scripts/build-all.js or equivalent root build logic

Before editing shared root scripts/package.json, inspect them and preserve every path still required by 8thwall/. The root build must continue to build/assemble active 8th Wall projects. Do not move, delete, mass-refactor or silently migrate 8thwall/.

Create/update MIGRATION.md with ONLY the concepts:
- WEATHER//ROOM
- REALITY//FIELD
- CITY//ORBIT
- SOUND//SPACE
- ECHO//ROOM
and state that all IWSDK versions are greenfield and Git history must not be used as implementation reference.

Create/update root AGENTS.md so future agents know:
- Quest 3 / supported Android WebXR => apps/ with Meta IWSDK
- iPhone/iPad WebAR => active 8thwall/ implementations as needed
- XR Blocks is retired
- 8thwall/ is not legacy
- Battleship/Sea Battle remains working; an IWSDK counterpart is a separate deliberate task
- shared framework-neutral TypeScript should be extracted only when at least two real consumers justify it

Do not commit unless the environment/user policy explicitly allows it, but leave a coherent diff ready to commit.

# Phase 2 — create WEATHER//ROOM from scratch

Create 'apps/weather-room' with the CURRENT official '@iwsdk/create@latest'. Determine the valid invocation yourself from '--help'. Do not assume deprecated flags such as '--ai-tools'. Use TypeScript and an AR/MR starting point. Enable current official IWSDK features needed for:
- scene understanding / room surfaces where supported
- environment raycasts / real-world placement where supported
- grabbing/interaction
- physics where it meaningfully supports the experience

After scaffolding:
- inspect generated AGENTS.md and '.agents/skills'
- run/sync current coding-tool adapters as appropriate
- warm and check the local IWSDK reference corpus
- sync generated Meta 'iwsdk-*' skills into root '.omp/skills/' using scripts/sync-iwsdk-skills.ps1; repair that helper if Meta changed paths
- use the installed reference corpus before writing IWSDK-specific APIs

Do NOT read old XR Blocks source or Git history for implementation. WEATHER//ROOM is greenfield.

# WEATHER//ROOM — product/experience specification

Primary target: Meta Quest 3 mixed reality.
Secondary target: supported Android Chrome/WebXR AR with capability-based degradation.
Desktop/IWER: development environment and useful non-hardware fallback, not evidence of Quest sensor correctness.

Core idea:
The user's real room becomes a physical visualization of local/current weather. Weather should feel like it occupies and reacts to the room rather than being a floating dashboard.

Weather source:
- Open-Meteo
- obtain location with a browser-compatible flow only with user permission; provide a sane fallback/demo location when permission/location is unavailable
- fetch enough hourly data in one request to support roughly -24h through +24h around NOW
- cache/normalize fetched data; never refetch every frame
- handle loading, denied location, offline/network failure and stale data visibly but unobtrusively

Data dimensions that must materially affect the scene:
- precipitation / rain
- wind speed and preferably direction when available
- cloud cover
- temperature
- atmospheric pressure

Timeline:
- spatial or comfortably reachable UI for -24h / NOW / +24h
- scrubbing/selecting time updates all weather manifestations coherently
- obvious way back to NOW
- show concise time/weather values without turning the experience into a conventional 2D weather app

Spatial manifestations:
- rain should occupy useful room volume and, where the platform exposes suitable room surfaces/colliders, visibly interact with real geometry rather than simply falling through everything
- wind should affect particles/rain/cloud/fog motion and provide readable direction/intensity
- cloud cover should change atmosphere/sky-like volume/light/fog density without obscuring passthrough dangerously
- temperature should have a restrained but immediately legible spatial/material/ambient encoding; avoid relying only on tiny text or a simplistic red-blue full-screen tint
- pressure should have a meaningful secondary spatial encoding (density, vertical compression/expansion, field behavior, etc.) rather than an arbitrary number pasted into UI
- all mappings should be documented briefly in code/project docs so another contributor understands what each weather variable controls

Quest 3 interaction goals, only where current browser/IWSDK capabilities actually support them:
- passthrough MR
- scene understanding / detected room surfaces
- environment raycasts
- occlusion/depth where available
- collision/interaction with real surfaces where justified
- hands and controllers
- spatial UI readable against real-world backgrounds

Android behavior:
- enter real camera AR only where immersive-ar is genuinely supported
- use hit-test/anchors/depth only after capability detection
- do not pretend Quest room meshes/scene understanding exist on phones that do not expose them
- gracefully reduce to placement + atmospheric visualization, or a clear supported fallback

Interaction and comfort:
- the first meaningful result should appear quickly
- no locomotion requirement for the basic experience
- controls must work at comfortable arm/reach distances
- effects must not make passthrough unusable
- avoid excessive particle counts on standalone hardware
- provide clear reset/recenter/reload-weather actions where useful

Art/game-feel direction:
- installation/art-experience rather than generic SaaS weather dashboard
- restrained readable typography
- strong single spatial idea per weather variable, not five unrelated particle gimmicks
- weather changes should produce a perceptible "room changed" moment
- keep enough subtlety that the real room remains visible
- avoid generic neon/cyberpunk/AI-generated visual language unless a concrete design reason emerges

# Phase 3 — autonomous implementation loop

The lead orchestrator owns the loop:

1. Research current IWSDK references/skills and plan the smallest coherent vertical slice.
2. Delegate bounded implementation work to 'iwsdk-builder'.
3. Integrate and inspect the code yourself.
4. Build/typecheck.
5. Start/use IWSDK managed runtime/IWER.
6. Enter XR in IWER where applicable and exercise the primary interaction/timeline.
7. Inspect console/runtime/scene/ECS state, not just whether Vite starts.
8. Capture app-only screenshots when the tooling supports it.
9. Fix failures and repeat.
10. At the first coherent playable/interactive milestone, invoke 'designer' once. Give it the app-only screenshots/runtime context and ask for prioritized spatial/game/visual changes. Implement the high-value fixes.
11. Before completion invoke 'iwsdk-reviewer' for independent technical review. Fix material findings and rerun verification.

Do not stop at scaffold/build success. Continue until there is a coherent working IWER-tested vertical slice or a concrete external/hardware blocker you cannot resolve locally.

# Phase 4 — acceptance criteria

Before calling the task complete:
- repository no longer depends on XR Blocks for active builds/setup
- 8thwall/ still exists and its root build path has not been intentionally broken
- apps/weather-room is a fresh IWSDK project
- npm build/typecheck for weather-room succeeds
- Open-Meteo flow works with loading/error/fallback handling
- -24h / NOW / +24h timeline changes the scene from cached hourly data
- all five weather variables have intentional scene mappings
- capability detection/degradation is explicit
- no deprecated/guessed IWSDK API remains when local references disagree
- IWER/runtime has been exercised, logs inspected, and obvious runtime errors fixed
- technical reviewer findings have been addressed
- designer milestone findings have been considered and high-value fixes applied
- README or app-level notes explain how to run/test the project and which behavior still needs Quest 3 / Android physical-device verification

Final response should be concise and factual:
- repository changes made
- WEATHER//ROOM features implemented
- commands/tests that actually passed
- what was verified in IWER
- what remains for a physical Quest 3 test
- Android capability caveats
- any intentionally deferred work
'@
Set-Content -Path (Join-Path $promptsDir "weather-room.md") -Value $weatherPrompt -Encoding UTF8

$syncScript = @'
param([Parameter(Mandatory=$true)][string]$AppPath)

$ErrorActionPreference = "Stop"
$repo = (& git rev-parse --show-toplevel).Trim()
$app = Resolve-Path $AppPath
$source = Join-Path $app ".agents\skills"
$dest = Join-Path $repo ".omp\skills"

if (-not (Test-Path $source)) {
  throw "No generated IWSDK Agent Skills found at $source. Inspect the current @iwsdk/create output before changing this helper."
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

Say "Leaving repository migration and IWSDK scaffolding to the OMP lead"
Write-Host "Bootstrap will not delete XR Blocks, modify root build files, or scaffold apps/weather-room."
Write-Host "Those actions are specified in .omp/prompts/weather-room.md and must be performed adaptively by OMP."

Say "Validating project-local OMP settings"
& omp config get modelRoles --json | Out-Host
& omp config get retry.fallbackChains --json | Out-Host

Write-Host ""
Write-Host "Bootstrap complete." -ForegroundColor Green
Write-Host "Project OMP config: .omp/config.yml"
Write-Host "Meta rules:         .omp/RULES.md"
Write-Host "Agents:             .omp/agents/"
Write-Host "IWSDK skills:       .omp/skills/ (OMP syncs these after scaffolding)"
Write-Host "Weather prompt:     .omp/prompts/weather-room.md"
Write-Host ""
Write-Host "No PAYG provider was configured. Model selectors came from your local OMP catalog."

if (-not $NoLaunch) {
  Say "Launching OMP with WEATHER//ROOM task"
  $prompt = Get-Content (Join-Path $promptsDir "weather-room.md") -Raw
  & omp $prompt
}
