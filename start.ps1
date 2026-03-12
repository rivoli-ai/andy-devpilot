#Requires -Version 5.1
<#
.SYNOPSIS
    DevPilot — single entry point for Windows.

.PARAMETER Rebuild
    Force rebuild of all Docker images.

.PARAMETER Stop
    Stop all running services.

.PARAMETER Reset
    Stop all services and remove volumes (wipes the database).

.EXAMPLE
    .\start.ps1
    .\start.ps1 -Rebuild
    .\start.ps1 -Stop
    .\start.ps1 -Reset
#>
param(
    [switch]$Rebuild,
    [switch]$Stop,
    [switch]$Reset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Info { param($msg) Write-Host "  [INFO]  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  [WARN]  $msg" -ForegroundColor Yellow }

$repoRoot = $PSScriptRoot
$envFile  = Join-Path $repoRoot ".env"

# ── .env check ────────────────────────────────────────────────────────────────
if (-not (Test-Path $envFile)) {
    Write-Warn ".env not found -- creating from template..."
    Copy-Item "$repoRoot\infra\local\.env.example" $envFile
    Write-Host ""
    Write-Host "  !! Fill in .env at the repo root, then re-run this script." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# ── Handle -Stop / -Reset without building the sandbox image ─────────────────
if ($Stop -or $Reset) {
    $args = @()
    if ($Stop)   { $args += "-Stop" }
    if ($Reset)  { $args += "-Reset" }
    & "$repoRoot\infra\local\setup.ps1" @args
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   DevPilot - Starting full stack         " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Build devpilot-desktop sandbox image ─────────────────────────────
Write-Step "Step 1/2 - Building sandbox image (devpilot-desktop)..."

$desktopExists = docker images -q devpilot-desktop:latest 2>$null
if ($desktopExists -and -not $Rebuild) {
    Write-Info "devpilot-desktop already built. Skipping. (use -Rebuild to force)"
} else {
    $buildArgs = @()
    if ($Rebuild) { $buildArgs += "-Rebuild" }
    & "$repoRoot\infra\sandbox\windows\setup.ps1" @buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN]  Sandbox image build failed. The stack will start but sandboxes may not work." -ForegroundColor Yellow
    }
}

# ── Step 2: Start backend + frontend + postgres + sandbox-manager ─────────────
Write-Step "Step 2/2 - Starting backend, frontend, postgres, sandbox manager..."

$args = @()
if ($Rebuild) { $args += "-Rebuild" }
& "$repoRoot\infra\local\setup.ps1" @args
exit $LASTEXITCODE
