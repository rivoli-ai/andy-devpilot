#Requires -Version 5.1
<#
.SYNOPSIS
    DevPilot Sandbox — Local K8s setup for Windows.
    Equivalent of setup-local.sh for Docker Desktop K8s, k3d, or minikube on Windows.

.DESCRIPTION
    Builds devpilot-desktop and devpilot-manager images, applies K8s manifests,
    and starts the sandbox manager pod.

.PARAMETER ApiKey
    Fixed API key to use. If not provided, reads MANAGER_API_KEY env var,
    then reuses existing K8s secret, or generates a new key as last resort.

.PARAMETER Rebuild
    Force full rebuild of both Docker images (ignores cache).

.EXAMPLE
    .\setup-local.ps1
    .\setup-local.ps1 -ApiKey "my_fixed_key"
    .\setup-local.ps1 -Rebuild
#>
param(
    [string]$ApiKey  = "",
    [switch]$Rebuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Info { param($msg) Write-Host "  [INFO]  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  [WARN]  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  [FAIL]  $msg" -ForegroundColor Red; exit 1 }

# ── Paths ─────────────────────────────────────────────────────────────────────
$scriptDir    = $PSScriptRoot
$repoRoot     = (Resolve-Path "$scriptDir\..\..\..").Path
$sandboxDir   = Join-Path $repoRoot "infra\sandbox"
$managerDir   = Join-Path $sandboxDir "manager"
$manifestsDir = Join-Path $scriptDir "manifests"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "   DevPilot Sandbox - K8s Local Setup     " -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host ""

# ── Load .env files ───────────────────────────────────────────────────────────
# Load order: repo root .env first, then infra/sandbox/k8s/.env (overrides root)
function Import-EnvFile { param($path)
    if (Test-Path $path) {
        Get-Content $path | Where-Object { $_ -match "^\s*[^#\s].*=.*" } | ForEach-Object {
            $parts = $_ -split "=", 2
            if ($parts.Count -eq 2) {
                [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
            }
        }
        Write-Info "Loaded .env from $path"
    }
}

Import-EnvFile (Join-Path $repoRoot ".env")
Import-EnvFile (Join-Path $scriptDir ".env")

# ── 1. Check prerequisites ────────────────────────────────────────────────────
Write-Step "Checking prerequisites..."

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Write-Fail "kubectl not found. Enable Kubernetes in Docker Desktop or install k3d."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "docker not found. Install Docker Desktop."
}

# Detect cluster type
$context = kubectl config current-context 2>$null
$clusterType = "unknown"
if ($context -match "docker-desktop") { $clusterType = "docker-desktop" }
elseif ($context -match "k3d")         { $clusterType = "k3d" }
elseif ($context -match "minikube")    { $clusterType = "minikube" }

Write-Info "Cluster context: $context (type: $clusterType)"

try {
    kubectl cluster-info --request-timeout=5s 2>&1 | Out-Null
    Write-Info "K8s cluster is reachable"
} catch {
    Write-Fail "K8s cluster is not reachable. Start Docker Desktop K8s or run: k3d cluster create devpilot"
}

# ── 2. Configure API key ──────────────────────────────────────────────────────
Write-Step "Configuring API key..."

if (-not $ApiKey) {
    # Priority: --ApiKey param > MANAGER_API_KEY env var > existing K8s secret > generate
    if ($env:MANAGER_API_KEY) {
        $ApiKey = $env:MANAGER_API_KEY
        Write-Info "Using MANAGER_API_KEY from environment"
    } else {
        # Try to reuse existing key from K8s secret
        $existingB64 = kubectl get secret manager-secrets -n sandboxes `
            -o "jsonpath={.data.MANAGER_API_KEY}" 2>$null
        if ($existingB64) {
            $ApiKey = [System.Text.Encoding]::UTF8.GetString(
                [System.Convert]::FromBase64String($existingB64)
            )
            Write-Info "Reusing existing API key from K8s secret"
        } else {
            # Generate a cryptographically random key
            $bytes = New-Object byte[] 32
            [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            $ApiKey = [Convert]::ToBase64String($bytes) -replace "\+","-" -replace "/","_" -replace "=",""
            Write-Warn "No MANAGER_API_KEY env var found -- generated a new key."
            Write-Warn "Set MANAGER_API_KEY in infra\sandbox\k8s\.env to use a fixed key."
        }
    }
}

# ── 3. Build devpilot-desktop image ──────────────────────────────────────────
Write-Step "Building devpilot-desktop image..."

$desktopExists = docker images -q devpilot-desktop:latest 2>$null
if ($desktopExists -and -not $Rebuild) {
    Write-Info "devpilot-desktop image already exists. Use -Rebuild to force rebuild."
} else {
    if ($Rebuild) { Write-Warn "Forcing rebuild (-Rebuild flag)" }
    Write-Info "Building desktop image via Linux build container (this takes 10-20 min first time)..."

    # Same technique as windows/setup.ps1 — run setup.sh with BUILD_ONLY=1 inside a Linux container
    $driveLetter   = $sandboxDir.Substring(0,1).ToLower()
    $dockerSandbox = "/" + $driveLetter + ($sandboxDir.Substring(2) -replace "\\", "/")

    $innerScript = "${dockerSandbox}/build-desktop-docker-inner.sh"

    $proc = Start-Process -FilePath "docker" -ArgumentList @(
        "run", "--rm",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        # Mount sandbox dir read-write so the build container can write logs (build.log)
        "-v", "${sandboxDir}:${dockerSandbox}:rw",
        "-e", "BUILD_ONLY=1",
        "-e", "SCRIPT_SOURCE_DIR=${dockerSandbox}",
        "-w", $dockerSandbox,
        "ubuntu:24.04",
        "bash", $innerScript
    ) -NoNewWindow -PassThru -Wait

    if ($proc.ExitCode -ne 0) { Write-Fail "Desktop image build failed." }

    $desktopExists = docker images -q devpilot-desktop:latest 2>$null
    if (-not $desktopExists) { Write-Fail "Image 'devpilot-desktop' was not created." }
    Write-Info "devpilot-desktop built successfully"
}

# Load into cluster if needed
if ($clusterType -eq "k3d") {
    $clusterName = $context -replace "^k3d-", ""
    Write-Info "Loading devpilot-desktop into k3d cluster '$clusterName'..."
    k3d image import devpilot-desktop:latest -c $clusterName
} elseif ($clusterType -eq "minikube") {
    Write-Info "Loading devpilot-desktop into minikube..."
    minikube image load devpilot-desktop:latest
} else {
    Write-Info "Docker Desktop K8s shares the Docker daemon -- image already available"
}

# ── 4. Build devpilot-manager image ──────────────────────────────────────────
Write-Step "Building devpilot-manager image..."

$proc = Start-Process -FilePath "docker" -ArgumentList @(
    "build", "-t", "devpilot-manager:local", $managerDir
) -NoNewWindow -PassThru -Wait
if ($proc.ExitCode -ne 0) { Write-Fail "Manager image build failed." }

if ($clusterType -eq "k3d") {
    $clusterName = $context -replace "^k3d-", ""
    k3d image import devpilot-manager:local -c $clusterName
} elseif ($clusterType -eq "minikube") {
    minikube image load devpilot-manager:local
}

Write-Info "Manager image built"

# ── 5. Apply K8s manifests ────────────────────────────────────────────────────
Write-Step "Applying K8s manifests..."

kubectl apply -f "$manifestsDir\namespace.yaml"
kubectl apply -f "$manifestsDir\rbac.yaml"

# Create/update the manager secret
kubectl create secret generic manager-secrets `
    --from-literal=MANAGER_API_KEY="$ApiKey" `
    --from-literal=HOST_IP="localhost" `
    --from-literal=BACKEND="k8s" `
    --from-literal=SANDBOX_IMAGE="devpilot-desktop:latest" `
    --from-literal=IMAGE_PULL_SECRET="" `
    -n sandboxes `
    --dry-run=client -o yaml | kubectl apply -f -

# Patch manager-deployment.yaml: swap GHCR image for local, set imagePullPolicy: Never
$deployYaml = Get-Content "$manifestsDir\manager-deployment.yaml" -Raw
$deployYaml = $deployYaml -replace "ghcr\.io/YOUR_ORG/devpilot-manager:latest", "devpilot-manager:local"
$deployYaml = $deployYaml -replace "imagePullPolicy: Always", "imagePullPolicy: Never"
$deployYaml | kubectl apply -f -

Write-Info "Manifests applied"

# ── 6. Wait for manager pod ───────────────────────────────────────────────────
Write-Step "Waiting for sandbox-manager pod to be ready..."

kubectl rollout restart deployment/sandbox-manager -n sandboxes 2>$null
kubectl rollout status deployment/sandbox-manager -n sandboxes --timeout=120s

Write-Info "Manager is ready"

# ── 7. Health check ───────────────────────────────────────────────────────────
Write-Step "Health check..."

Start-Sleep -Seconds 3
try {
    $health = Invoke-RestMethod -Uri "http://localhost:30090/health" -TimeoutSec 5
    Write-Info "Health check passed: status=$($health.status) backend=$($health.backend)"
} catch {
    Write-Warn "Manager did not respond at :30090 yet."
    Write-Warn "Check logs: kubectl logs -f deployment/sandbox-manager -n sandboxes"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  K8s local setup complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Manager API  : http://localhost:30090" -ForegroundColor Cyan
Write-Host "  API key      : $ApiKey" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Update backend\src\API\appsettings.Development.json:" -ForegroundColor White
Write-Host '  "VPS": {' -ForegroundColor Gray
Write-Host '    "GatewayUrl":    "http://localhost:30090",' -ForegroundColor Gray
Write-Host "    `"ManagerApiKey`": `"$ApiKey`"," -ForegroundColor Gray
Write-Host '    "PublicIp":      "localhost",' -ForegroundColor Gray
Write-Host '    "Enabled":       true' -ForegroundColor Gray
Write-Host '  }' -ForegroundColor Gray
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor White
Write-Host "    kubectl get pods -n sandboxes" -ForegroundColor Gray
Write-Host "    kubectl logs -f deployment/sandbox-manager -n sandboxes" -ForegroundColor Gray
Write-Host "    kubectl get services -n sandboxes" -ForegroundColor Gray
Write-Host ""
