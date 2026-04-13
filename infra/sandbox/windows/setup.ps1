#Requires -Version 5.1
<#
.SYNOPSIS
    DevPilot Sandbox setup for Windows (Docker Desktop, no WSL required).

.DESCRIPTION
    Builds the devpilot-desktop image and starts the sandbox manager as a
    Docker container. Docker Desktop must be running (Hyper-V or WSL2 backend).

.PARAMETER HostIP
    Your machine's IP address that sandbox containers will use for their URLs.
    Defaults to 'localhost'. Use your LAN IP if the backend runs on another machine.

.PARAMETER Rebuild
    Force a full rebuild of the devpilot-desktop image (ignores Docker cache).

.EXAMPLE
    .\setup.ps1
    .\setup.ps1 -HostIP 192.168.1.50
    .\setup.ps1 -Rebuild
#>
param(
    [string]$HostIP = "localhost",
    [switch]$Rebuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# - Colours -
function Write-Step  { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# - Paths -
$windowsDir = $PSScriptRoot
$sandboxDir  = (Resolve-Path (Split-Path $windowsDir -Parent)).Path   # infra/sandbox (absolute)
$envFile     = Join-Path $windowsDir ".env"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "   DevPilot Sandbox - Windows Setup       " -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host ""

# - 1. Check Docker Desktop -
Write-Step "Checking Docker Desktop..."
try {
    $null = docker info 2>&1
    Write-Ok "Docker Desktop is running"
} catch {
    Write-Fail "Docker Desktop is not running or not installed."
    Write-Host "  Install from https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

# - 2. On -Rebuild, clean everything first -
if ($Rebuild) {
    Write-Step "Cleaning up everything before rebuild..."

    # Stop and remove ALL sandbox containers (sandbox-*)
    cmd /c "docker rm -f $(docker ps -aq --filter name=sandbox- 2>nul) 2>nul" | Out-Null

    # Stop and remove the standalone manager + build container
    cmd /c "docker rm -f devpilot-sandbox-manager devpilot-desktop-builder 2>nul" | Out-Null

    # Remove the standalone manager compose stack
    Push-Location $windowsDir
    cmd /c "docker compose down --remove-orphans -v 2>nul" | Out-Null
    Pop-Location

    # Remove images (ignore errors if they don't exist)
    cmd /c "docker rmi devpilot-desktop:latest devpilot-sandbox-manager:latest 2>nul" | Out-Null

    # Prune dangling images
    cmd /c "docker image prune -f 2>nul" | Out-Null

    Write-Ok "Cleanup complete - starting fresh."
}

# - 3. Build the devpilot-desktop image -
Write-Step "Building devpilot-desktop image (this can take 10-20 min on first run)..."

$imageExists = docker images -q devpilot-desktop 2>$null
if ($imageExists -and -not $Rebuild) {
    Write-Ok "devpilot-desktop image already exists. Use -Rebuild to force a rebuild."
} else {
    # Convert Windows path to Docker-friendly format (e.g. C:\Users\... -> /c/Users/...)
    $absSandboxDir = (Resolve-Path $sandboxDir).Path
    if ($absSandboxDir -match '^([A-Za-z]):(.*)') {
        $dockerSandboxDir = "/" + $Matches[1].ToLower() + ($Matches[2] -replace "\\", "/")
    } else {
        Write-Fail "Cannot convert path to Docker format: $absSandboxDir"
        exit 1
    }

    Write-Host "  Running setup.sh in a Linux build container..." -ForegroundColor Gray
    Write-Host "  Mounted sandbox dir: $dockerSandboxDir" -ForegroundColor Gray

    $innerScript = "${dockerSandboxDir}/build-desktop-docker-inner.sh"

    cmd /c "docker rm -f devpilot-desktop-builder 2>nul" | Out-Null

    # Also mount repo-root certs/ so the build container can trust corporate proxies
    $repoRoot = Split-Path $sandboxDir -Parent
    $absRepoRoot = (Resolve-Path $repoRoot).Path
    if ($absRepoRoot -match '^([A-Za-z]):(.*)') {
        $dockerRepoRoot = "/" + $Matches[1].ToLower() + ($Matches[2] -replace "\\", "/")
    } else {
        $dockerRepoRoot = $absRepoRoot -replace "\\", "/"
    }
    $dockerCertsDir = "${dockerRepoRoot}/certs"

    $buildArgs = @(
        "run", "--rm", "--name", "devpilot-desktop-builder",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "${absSandboxDir}:${dockerSandboxDir}:rw",
        "-v", "${absRepoRoot}\certs:${dockerCertsDir}:ro",
        "-e", "BUILD_ONLY=1",
        "-e", "SCRIPT_SOURCE_DIR=${dockerSandboxDir}",
        "-e", "CERTS_DIR=${dockerCertsDir}",
        "-w", $dockerSandboxDir,
        "ubuntu:24.04",
        "bash", $innerScript
    )

    $proc = Start-Process -FilePath "docker" -ArgumentList $buildArgs -NoNewWindow -PassThru -Wait

    cmd /c "docker rm -f devpilot-desktop-builder 2>nul" | Out-Null

    if ($proc.ExitCode -ne 0) {
        Write-Fail "Desktop image build failed (exit code $($proc.ExitCode))."
        Write-Host "  Check the output above for errors." -ForegroundColor Yellow
        exit 1
    }

    $imageExists = docker images -q devpilot-desktop 2>$null
    if (-not $imageExists) {
        Write-Fail "Image 'devpilot-desktop' was not created. Something went wrong."
        exit 1
    }
    Write-Ok "devpilot-desktop image built successfully"
}

# - 3. Generate or load API key -
Write-Step "Configuring API key..."

# Required under Set-StrictMode: .env may exist without MANAGER_API_KEY, so $apiKey might never be assigned.
$apiKey = $null

# Priority: env var > existing .env > generate new
if ($env:MANAGER_API_KEY) {
    $apiKey = $env:MANAGER_API_KEY
    Write-Ok "Using MANAGER_API_KEY from environment"
} elseif (Test-Path $envFile) {
    $existing = Get-Content $envFile | Where-Object { $_ -match "^MANAGER_API_KEY=" }
    if ($existing) {
        $apiKey = ($existing -split "=", 2)[1]
        Write-Ok "Reusing existing API key from .env"
    }
}

if (-not $apiKey) {
    # Generate a cryptographically random 32-byte key (base64url encoded)
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $apiKey = [Convert]::ToBase64String($bytes) -replace "\+", "-" -replace "/", "_" -replace "=", ""
    Write-Warn "No MANAGER_API_KEY env var found -- generated a new key."
}

# Write .env file
@"
MANAGER_API_KEY=$apiKey
HOST_IP=$HostIP
"@ | Set-Content $envFile -Encoding UTF8

Write-Ok "Wrote .env (HOST_IP=$HostIP)"

# - 4. Stop conflicting sandbox-manager from main docker-compose (if any) -
$rootComposeFile = Join-Path (Split-Path $sandboxDir -Parent | Split-Path -Parent) "docker-compose.yml"
$mainManager = docker ps -q --filter "name=sandbox-manager" --filter "label=com.docker.compose.service=sandbox-manager" 2>$null
if ($mainManager) {
    Write-Step "Stopping sandbox-manager from main docker-compose (port conflict)..."
    cmd /c "docker compose -f `"$rootComposeFile`" stop sandbox-manager 2>nul" | Out-Null
    cmd /c "docker compose -f `"$rootComposeFile`" rm -f sandbox-manager 2>nul" | Out-Null
    Write-Ok "Main docker-compose sandbox-manager stopped."
}

# - 5. Build manager image (only if missing) and start with docker-compose -
$managerRunning = docker ps -q --filter "name=devpilot-sandbox-manager" 2>$null

if ($managerRunning -and -not $Rebuild) {
    Write-Step "Sandbox manager already running. Skipping -- use -Rebuild to recreate."
} else {
    $managerImage = docker images -q "devpilot-sandbox-manager:latest" 2>$null
    if ($managerImage -and -not $Rebuild) {
        Write-Step "devpilot-sandbox-manager image exists -- starting without rebuild..."
    } else {
        if ($Rebuild) { Write-Step "Rebuilding sandbox manager image..." }
        else          { Write-Step "Building sandbox manager image for the first time..." }
    }

    Push-Location $windowsDir
    try {
        cmd /c "docker compose down --remove-orphans 2>nul" | Out-Null
        if ($managerImage -and -not $Rebuild) {
            $proc = Start-Process -FilePath "docker" -ArgumentList @("compose", "up", "-d", "--no-build") -NoNewWindow -PassThru -Wait
        } else {
            $proc = Start-Process -FilePath "docker" -ArgumentList @("compose", "up", "-d", "--build") -NoNewWindow -PassThru -Wait
        }
        if ($proc.ExitCode -ne 0) {
            Write-Fail "Failed to start sandbox manager."
            exit 1
        }
    } finally {
        Pop-Location
    }
}

# - 5. Health check -
Write-Step "Waiting for manager to be ready..."
$maxWait = 30
$waited  = 0
$ready   = $false
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 2
    $waited += 2
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8090/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch { }
    Write-Host "  Waiting... $($waited)s" -ForegroundColor Gray
}

if ($ready) {
    Write-Ok "Manager is up at http://localhost:8090"
} else {
    Write-Warn "Manager did not respond in ${maxWait}s -- check logs: docker logs devpilot-sandbox-manager"
}

# - 6. Patch VPS__GatewayUrl in root .env so the backend points at this manager -
$rootEnvFile = Join-Path (Split-Path $sandboxDir -Parent | Split-Path -Parent) ".env"
if (Test-Path $rootEnvFile) {
    Write-Step "Patching VPS__GatewayUrl in root .env..."
    $gatewayUrl = "http://host.docker.internal:8090"
    $envContent = Get-Content $rootEnvFile -Raw
    if ($envContent -match "(?m)^VPS__GatewayUrl=") {
        $envContent = $envContent -replace "(?m)^VPS__GatewayUrl=.*", "VPS__GatewayUrl=$gatewayUrl"
    } else {
        $envContent += "`nVPS__GatewayUrl=$gatewayUrl"
    }
    Set-Content $rootEnvFile $envContent -NoNewline
    Write-Ok "VPS__GatewayUrl set to: $gatewayUrl"
} else {
    Write-Warn "Root .env not found at $rootEnvFile - update VPS__GatewayUrl manually."
}

# - Summary -
Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Manager API   : http://localhost:8090" -ForegroundColor Cyan
Write-Host "  Manager key   : $apiKey" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Update your backend appsettings:" -ForegroundColor Yellow
Write-Host '  "VPS": {' -ForegroundColor Gray
Write-Host '    "GatewayUrl": "http://localhost:8090",' -ForegroundColor Gray
Write-Host "    `"ManagerApiKey`": `"$apiKey`"," -ForegroundColor Gray
Write-Host '    "PublicIp": "localhost",' -ForegroundColor Gray
Write-Host '    "Enabled": true' -ForegroundColor Gray
Write-Host '  }' -ForegroundColor Gray
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Yellow
Write-Host "    docker logs -f devpilot-sandbox-manager   # live logs"
Write-Host "    docker ps --filter name=sandbox-          # running sandboxes"
Write-Host "    docker compose -f infra\sandbox\windows\docker-compose.yml down"
Write-Host ""
