#Requires -Version 5.1
<#
.SYNOPSIS
    DevPilot — single entry point for Windows.

.PARAMETER Mode
    Deployment mode: 'docker' (Docker Compose) or 'k8s' (Kubernetes).
    If omitted, the script will ask interactively.

.PARAMETER Rebuild
    Force rebuild of all Docker images.

.PARAMETER Stop
    Stop all running services.

.PARAMETER Reset
    Stop all services and remove volumes (wipes the database).

.EXAMPLE
    .\start.ps1                    # interactive — asks Docker vs K8s
    .\start.ps1 -Mode docker       # skip prompt, use Docker Compose
    .\start.ps1 -Mode k8s          # skip prompt, use Kubernetes
    .\start.ps1 -Rebuild
    .\start.ps1 -Stop
    .\start.ps1 -Reset
#>
param(
    [ValidateSet("docker", "k8s", "")]
    [string]$Mode = "",
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

# ── Handle -Stop / -Reset ─────────────────────────────────────────────────────
if ($Stop -or $Reset) {
    $passArgs = @()
    if ($Stop)  { $passArgs += "-Stop" }
    if ($Reset) { $passArgs += "-Reset" }
    $target = if ($Mode -eq "k8s") { "$repoRoot\infra\sandbox\k8s\setup-local.ps1" } `
                                   else { "$repoRoot\infra\local\setup.ps1" }
    & $target @passArgs
    exit $LASTEXITCODE
}

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "        DevPilot - Start                  " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── Ask deployment mode if not provided ──────────────────────────────────────
if (-not $Mode) {
    Write-Host "  Choose a deployment mode:`n"
    Write-Host "    1) Docker Compose  - everything runs in containers locally (recommended)" -ForegroundColor White
    Write-Host "    2) Kubernetes      - local K8s cluster (Docker Desktop / k3d / minikube)" -ForegroundColor White
    Write-Host ""
    $choice = Read-Host "  Enter choice [1/2]"
    switch ($choice) {
        { $_ -in "1","docker" } { $Mode = "docker" }
        { $_ -in "2","k8s"   } { $Mode = "k8s"    }
        default {
            Write-Host "`n  Invalid choice. Defaulting to Docker Compose.`n" -ForegroundColor Yellow
            $Mode = "docker"
        }
    }
}

Write-Host ""
Write-Info "Mode: $Mode"

# ── Patch VPS__GatewayUrl in .env to match the selected mode ─────────────────
# Docker: localhost:8090 (sandbox-manager container, port forwarded to host)
# K8s:    localhost:30090 (NodePort for the sandbox manager service)
function Set-GatewayUrl {
    param([string]$Url)
    $content = Get-Content $envFile -Raw
    if ($content -match "(?m)^VPS__GatewayUrl=") {
        $content = $content -replace "(?m)^VPS__GatewayUrl=.*", "VPS__GatewayUrl=$Url"
    } else {
        $content += "`nVPS__GatewayUrl=$Url"
    }
    Set-Content $envFile $content -NoNewline
    Write-Info "VPS__GatewayUrl set to: $Url"
}

if ($Mode -eq "docker") { Set-GatewayUrl "http://localhost:8090" }
elseif ($Mode -eq "k8s") { Set-GatewayUrl "http://localhost:30090" }

$passArgs = @()
if ($Rebuild) { $passArgs += "-Rebuild" }

# ── Helper: stop conflicting mode before starting ────────────────────────────
function Stop-DockerCompose {
    $running = docker compose -f "$repoRoot\docker-compose.yml" ps -q 2>$null
    if ($running) {
        Write-Warn "Docker Compose stack is running -- stopping it before switching to K8s..."
        docker compose -f "$repoRoot\docker-compose.yml" down
        Write-Info "Docker Compose stack stopped."
    }
}

function Stop-K8s {
    $ns = kubectl get namespace sandboxes 2>$null
    if ($ns) {
        Write-Warn "K8s sandbox namespace found -- stopping it before switching to Docker..."
        kubectl delete namespace sandboxes --ignore-not-found
        Write-Info "K8s sandboxes namespace removed."
    }
}

function Build-DesktopImage {
    $desktopExists = docker images -q devpilot-desktop:latest 2>$null
    if ($desktopExists -and -not $Rebuild) {
        Write-Info "devpilot-desktop already built. Skipping. (use -Rebuild to force)"
    } else {
        & "$repoRoot\infra\sandbox\windows\setup.ps1" @passArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Sandbox image build failed. Sandboxes may not work."
        }
    }
}

# ══════════════════════════════════════════════════════════════════════════════
# DOCKER COMPOSE MODE
# ══════════════════════════════════════════════════════════════════════════════
if ($Mode -eq "docker") {

    Stop-K8s

    Write-Step "Step 1/2 - Building sandbox image (devpilot-desktop)..."
    Build-DesktopImage

    Write-Step "Step 2/2 - Starting backend, frontend, postgres, sandbox manager..."
    & "$repoRoot\infra\local\setup.ps1" @passArgs
    exit $LASTEXITCODE

# ══════════════════════════════════════════════════════════════════════════════
# KUBERNETES MODE
# ══════════════════════════════════════════════════════════════════════════════
} elseif ($Mode -eq "k8s") {

    Stop-DockerCompose

    Write-Step "Step 1/2 - Building sandbox image (devpilot-desktop)..."
    Build-DesktopImage

    Write-Step "Step 2/2 - Setting up Kubernetes cluster..."
    & "$repoRoot\infra\sandbox\k8s\setup-local.ps1" @passArgs
    exit $LASTEXITCODE
}
