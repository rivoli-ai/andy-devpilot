#Requires -Version 5.1
<#
.SYNOPSIS
    DevPilot — Full local stack setup for Windows.
    Builds and starts: PostgreSQL + Backend + Frontend + Sandbox Manager.

.PARAMETER Rebuild
    Force rebuild of all Docker images.

.PARAMETER Stop
    Stop all running services.

.PARAMETER Reset
    Stop all services and remove volumes (wipes the database).

.EXAMPLE
    .\infra\local\setup.ps1
    .\infra\local\setup.ps1 -Rebuild
    .\infra\local\setup.ps1 -Stop
    .\infra\local\setup.ps1 -Reset
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
function Write-Fail { param($msg) Write-Host "  [FAIL]  $msg" -ForegroundColor Red; exit 1 }

$scriptDir    = $PSScriptRoot
$repoRoot     = (Resolve-Path "$scriptDir\..\..\").Path
$envFile      = Join-Path $repoRoot ".env"
$composeFile  = Join-Path $repoRoot "docker-compose.yml"

# ── Stop / Reset ──────────────────────────────────────────────────────────────
if ($Stop) {
    Write-Step "Stopping all services..."
    docker compose -f $composeFile down
    Write-Info "All services stopped."
    exit 0
}
if ($Reset) {
    Write-Step "Stopping all services and removing volumes (this wipes the database)..."
    docker compose -f $composeFile down -v
    Write-Info "All services stopped and volumes removed."
    exit 0
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   DevPilot - Local Stack Setup           " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check prerequisites ────────────────────────────────────────────────────
Write-Step "Checking prerequisites..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Fail "Docker not found. Install Docker Desktop." }
try { docker info 2>&1 | Out-Null } catch { Write-Fail "Docker daemon is not running." }
Write-Info "Docker is running"

# ── 2. Create .env if missing ─────────────────────────────────────────────────
Write-Step "Checking .env configuration..."
if (-not (Test-Path $envFile)) {
    Write-Warn ".env not found -- creating from template..."
    Copy-Item "$scriptDir\.env.example" $envFile
    Write-Host ""
    Write-Host "  !! ACTION REQUIRED: Edit .env at the repo root and fill in your values, then re-run this script." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
Write-Info ".env found at $envFile"

# ── 3. Build devpilot-desktop image (needed by sandbox manager) ───────────────
Write-Step "Checking devpilot-desktop image..."
$desktopExists = docker images -q devpilot-desktop:latest 2>$null
if ($desktopExists -and -not $Rebuild) {
    Write-Info "devpilot-desktop already exists. Use -Rebuild to force rebuild."
} else {
    if ($Rebuild) { Write-Warn "Rebuilding devpilot-desktop..." }
    else { Write-Info "Building devpilot-desktop (this takes 10-20 min first time)..." }

    $sandboxDir  = Join-Path $repoRoot "infra\sandbox"
    $driveLetter = $sandboxDir.Substring(0,1).ToLower()
    $dockerPath  = "/" + $driveLetter + ($sandboxDir.Substring(2) -replace "\\", "/")

    # Run build-desktop-docker-inner.sh (not bash -c multi-line — Start-Process can break that on Windows).
    $innerScript = "${dockerPath}/build-desktop-docker-inner.sh"

    $certsDir = Join-Path $repoRoot "certs"
    $dockerCertsDir = "/" + $driveLetter + ((Join-Path $repoRoot "certs").Substring(2) -replace "\\", "/")

    $buildArgs = @(
        "run", "--rm",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "${sandboxDir}:${dockerPath}:rw",
        "-v", "${certsDir}:${dockerCertsDir}:ro",
        "-e", "BUILD_ONLY=1",
        "-e", "SCRIPT_SOURCE_DIR=${dockerPath}",
        "-e", "CERTS_DIR=${dockerCertsDir}",
        "-w", $dockerPath,
        "ubuntu:24.04",
        "bash", $innerScript
    )

    $proc = Start-Process -FilePath "docker" -ArgumentList $buildArgs -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Write-Fail "devpilot-desktop build failed. If Docker reported EOF or pipe errors, restart Docker Desktop and retry. See infra/sandbox/build.log in the sandbox folder for details."
    }
    Write-Info "devpilot-desktop built successfully"
}

# ── 4. Build and start all services ──────────────────────────────────────────
Write-Step "Building and starting all services..."

if ($Rebuild) {
    Write-Warn "Rebuilding all images from scratch (--no-cache)..."
    $buildProc = Start-Process -FilePath "docker" -ArgumentList @("compose", "-f", $composeFile, "--env-file", $envFile, "build", "--no-cache") -NoNewWindow -PassThru -Wait
    if ($buildProc.ExitCode -ne 0) { Write-Fail "docker compose build --no-cache failed." }
}
$buildArgs = @("-f", $composeFile, "--env-file", $envFile, "up", "-d", "--force-recreate")

$proc = Start-Process -FilePath "docker" -ArgumentList (@("compose") + $buildArgs) -NoNewWindow -PassThru -Wait
if ($proc.ExitCode -ne 0) { Write-Fail "docker compose up failed." }

# ── 5. Wait for backend ───────────────────────────────────────────────────────
Write-Step "Waiting for backend to be ready..."
# Backend runs DB migrations on first start; allow several minutes.
$retries = 60
$ready   = $false
while ($retries -gt 0 -and -not $ready) {
    Start-Sleep -Seconds 3
    try {
        Invoke-RestMethod -Uri "http://localhost:8080/health" -TimeoutSec 10 | Out-Null
        $ready = $true
    } catch { $retries-- }
}
if ($ready) { Write-Info "Backend is ready" }
else { Write-Warn "Backend did not respond yet. Check: docker compose logs devpilot-backend" }

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  DevPilot local stack is running!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend        : http://localhost" -ForegroundColor Cyan
Write-Host "  Backend API     : http://localhost:8080/api" -ForegroundColor Cyan
Write-Host "  Sandbox Manager : http://localhost:8090/health" -ForegroundColor Cyan
Write-Host "  PostgreSQL      : localhost:5432" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Logs:" -ForegroundColor White
Write-Host "    docker compose logs -f devpilot-backend" -ForegroundColor Gray
Write-Host "    docker compose logs -f devpilot-frontend" -ForegroundColor Gray
Write-Host "    docker compose logs -f sandbox-manager" -ForegroundColor Gray
Write-Host ""
Write-Host "  Stop:  .\infra\local\setup.ps1 -Stop" -ForegroundColor Gray
Write-Host "  Reset: .\infra\local\setup.ps1 -Reset   (wipes DB)" -ForegroundColor Gray
Write-Host ""