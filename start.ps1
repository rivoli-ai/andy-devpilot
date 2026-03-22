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

# ── Handle -Stop / -Reset — clean BOTH modes so switching is seamless ─────────
if ($Stop -or $Reset) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Yellow
    Write-Host "  DevPilot - Cleaning up all services     " -ForegroundColor Yellow
    Write-Host "==========================================" -ForegroundColor Yellow
    Write-Host ""

    # 1. Stop Docker Compose (all services)
    $composeFile = Join-Path $repoRoot "docker-compose.yml"
    $composeRunning = docker compose -f $composeFile ps -q 2>$null
    if ($composeRunning) {
        Write-Warn "Stopping Docker Compose stack..."
        if ($Reset) {
            docker compose -f $composeFile down -v
            Write-Info "Docker Compose stopped and volumes removed."
        } else {
            docker compose -f $composeFile down
            Write-Info "Docker Compose stopped."
        }
    } else {
        Write-Info "Docker Compose is not running."
    }

    # 2. Stop K8s sandboxes namespace (if cluster is reachable)
    if (Get-Command kubectl -ErrorAction SilentlyContinue) {
        cmd /c "kubectl cluster-info --request-timeout=5s >nul 2>&1"
        if ($LASTEXITCODE -eq 0) {
            $ns = (cmd /c "kubectl get namespace sandboxes --ignore-not-found -o name 2>&1")
            if ($ns -and $ns -match "namespace") {
                Write-Warn "Removing K8s sandboxes namespace..."
                kubectl delete namespace sandboxes --ignore-not-found
                Write-Info "K8s sandboxes namespace removed."
            } else {
                Write-Info "No K8s sandboxes namespace found."
            }
        } else {
            Write-Info "K8s cluster not reachable - skipping."
        }
    }

    # 3. Remove sandbox containers (leftover from either mode)
    $sandboxContainers = docker ps -aq --filter "name=sandbox-" 2>$null
    if ($sandboxContainers) {
        Write-Warn "Removing leftover sandbox containers..."
        docker rm -f $sandboxContainers 2>$null
        Write-Info "Sandbox containers removed."
    }

    # 4. On -Reset, also remove built images and prune volumes
    if ($Reset) {
        Write-Warn "Removing DevPilot images..."
        docker rmi devpilot-desktop:latest 2>$null
        docker rmi devpilot-manager:local 2>$null
        docker image prune -f 2>$null
        docker volume prune -f 2>$null
        Write-Info "Images and unused volumes removed."
    }

    Write-Host ""
    Write-Info "Cleanup complete. Run .\start.ps1 to start fresh."
    Write-Host ""
    exit 0
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

if ($Mode -eq "docker") { Set-GatewayUrl "http://sandbox-manager:8090" }
elseif ($Mode -eq "k8s") { Set-GatewayUrl "http://host.docker.internal:30090" }

$passArgs = @()
if ($Rebuild) { $passArgs += "-Rebuild" }

# ── Helper: stop conflicting mode before starting ────────────────────────────
function Stop-ComposeSandboxManager {
    $running = docker compose -f "$repoRoot\docker-compose.yml" ps -q sandbox-manager 2>$null
    if ($running) {
        Write-Warn "Stopping docker-compose sandbox-manager (will run in K8s instead)..."
        docker compose -f "$repoRoot\docker-compose.yml" stop sandbox-manager
        docker compose -f "$repoRoot\docker-compose.yml" rm -f sandbox-manager
        Write-Info "docker-compose sandbox-manager stopped."
    }
}

function Stop-FullDockerCompose {
    $running = docker compose -f "$repoRoot\docker-compose.yml" ps -q 2>$null
    if ($running) {
        Write-Warn "Docker Compose stack is running -- stopping it..."
        docker compose -f "$repoRoot\docker-compose.yml" down
        Write-Info "Docker Compose stack stopped."
    }
}

function Test-KubectlClusterReachable {
    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
        return $false
    }
    # Use cmd so kubectl stderr does not become a PowerShell NativeCommandError (Stop mode).
    cmd /c "kubectl config current-context >nul 2>&1"
    if ($LASTEXITCODE -ne 0) { return $false }
    cmd /c "kubectl cluster-info --request-timeout=5s >nul 2>&1"
    return ($LASTEXITCODE -eq 0)
}

function Stop-K8s {
    if (-not (Test-KubectlClusterReachable)) {
        Write-Info "Skipping Kubernetes cleanup - kubectl cannot reach a cluster. If you use Docker Desktop, start it and enable Kubernetes (Docker Desktop Settings, Kubernetes tab). Otherwise check your kubeconfig. Docker Compose will continue."
        return
    }
    # --ignore-not-found: missing namespace must not write to stderr (PowerShell surfaces it as an error)
    $ns = (& kubectl get namespace sandboxes --ignore-not-found -o name 2>&1 | Out-String).Trim()
    if ($ns) {
        Write-Warn "K8s sandbox namespace found -- removing it before switching to Docker..."
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
# DOCKER COMPOSE MODE — all 4 services in docker-compose
# ══════════════════════════════════════════════════════════════════════════════
if ($Mode -eq "docker") {

    Stop-K8s

    Write-Step "Step 1/2 - Building sandbox image (devpilot-desktop)..."
    Build-DesktopImage

    Write-Step "Step 2/2 - Starting postgres, backend, frontend, sandbox-manager (docker-compose)..."
    & "$repoRoot\infra\local\setup.ps1" @passArgs
    exit $LASTEXITCODE

# ══════════════════════════════════════════════════════════════════════════════
# KUBERNETES MODE — sandbox-manager in K8s, rest in docker-compose
#   Ports in K8s mode:
#     sandbox-manager : localhost:30090  (K8s NodePort)
#     VNC per sandbox : localhost:30100+ (K8s NodePort pairs)
#     Bridge per sandbox: localhost:30101+
# ══════════════════════════════════════════════════════════════════════════════
} elseif ($Mode -eq "k8s") {

    # Stop only the sandbox-manager from docker-compose — keep backend/frontend/postgres running
    Stop-ComposeSandboxManager

    Write-Step "Step 1/2 - Building sandbox image (devpilot-desktop)..."
    Build-DesktopImage

    Write-Step "Step 2/2a - Starting postgres, backend, frontend (docker-compose, without sandbox-manager)..."
    docker compose -f "$repoRoot\docker-compose.yml" --env-file "$repoRoot\.env" `
        up -d postgres devpilot-backend devpilot-frontend

    Write-Step "Step 2/2b - Setting up sandbox-manager in Kubernetes..."
    & "$repoRoot\infra\sandbox\k8s\setup-local.ps1" @passArgs
    exit $LASTEXITCODE
}
