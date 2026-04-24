# -----------------------------------------------------------------------------
# DevPilot Identity Server - install script (Windows PowerShell)
#
# Usage:
#   .\install.ps1                           # generate certs + start
#   .\install.ps1 -NoCerts                  # skip cert generation
#   .\install.ps1 -TrustCert                # also trust cert in Windows store
#   .\install.ps1 -Username admin           # override admin username
#   .\install.ps1 -Port 5001                 # override IDS port
# -----------------------------------------------------------------------------
param(
    [switch]$NoCerts,
    [switch]$TrustCert,
    [int]$Port = 5001,
    [string]$Username = "ibenamara",
    [string]$Email = $null,
    [string]$DisplayName = $null,
    [string]$CertPassword = "devpassword",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

if ($Help) {
    Write-Host @'
Usage: .\install.ps1 [OPTIONS]

Options:
  -NoCerts        Skip certificate generation (reuse existing certs\)
  -TrustCert      Trust the certificate in Windows certificate store
  -Port PORT      Identity server port (default: 5001)
  -Username NAME  Admin username (default: ibenamara)
  -Email EMAIL    Admin email
  -DisplayName N  Admin display name
  -Help           Show this help
'@
    exit 0
}

# --- Derived defaults --------------------------------------------------------
if (-not $Email)       { $Email = "$Username@devpilot.local" }
if (-not $DisplayName) { $DisplayName = $Username }

# --- Check dependencies ------------------------------------------------------
Write-Host "==> Checking dependencies..."

$dockerPath = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerPath) {
    Write-Host "ERROR: 'docker' is required but not found. Please install Docker Desktop." -ForegroundColor Red
    exit 1
}

try {
    docker info 2>&1 | Out-Null
} catch {
    Write-Host "ERROR: Docker is not running. Please start Docker Desktop." -ForegroundColor Red
    exit 1
}
Write-Host "    docker  OK" -ForegroundColor Green

$hasOpenSSL = $null -ne (Get-Command openssl -ErrorAction SilentlyContinue)

# Self-signed cert via PowerShell (no openssl). Used when openssl is missing or fails.
function New-DevPilotLocalhostCertsPowerShell {
    param(
        [Parameter(Mandatory)][string]$CertsDir,
        [Parameter(Mandatory)][string]$PfxPasswordPlain
    )
    $cert = New-SelfSignedCertificate `
        -DnsName "localhost" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -NotAfter (Get-Date).AddYears(1) `
        -FriendlyName "DevPilot Identity Server"
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $pfxPass = ConvertTo-SecureString -String $PfxPasswordPlain -AsPlainText -Force
    } else {
        $pfxPass = New-Object System.Security.SecureString
        foreach ($ch in $PfxPasswordPlain.ToCharArray()) { $pfxPass.AppendChar($ch) }
    }
    Export-PfxCertificate -Cert $cert -FilePath "$CertsDir\localhost.pfx" -Password $pfxPass | Out-Null
    Export-Certificate -Cert $cert -FilePath "$CertsDir\localhost.crt" -Type CERT | Out-Null
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
}

# --- Generate admin password ------------------------------------------------
$bytes = New-Object byte[] 16
# Fill() is .NET 6+; Create().GetBytes() works on Windows PowerShell 5.1 / .NET Framework
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$AdminPassword = [Convert]::ToBase64String($bytes).Substring(0, 16) -replace '[/+=]', 'x'
$AdminPassword = "${AdminPassword}Dp1!"

Write-Host ""
Write-Host "==> Admin credentials"
Write-Host "    Username : $Username"
Write-Host "    Password : $AdminPassword"
Write-Host "    Email    : $Email"

# --- Generate certificates ---------------------------------------------------
$certsDir = Join-Path $ScriptDir "certs"

if (-not $NoCerts) {
    Write-Host ""
    Write-Host "==> Generating self-signed certificates..."
    New-Item -ItemType Directory -Force -Path $certsDir | Out-Null

    $opensslProducedCerts = $false
    if ($hasOpenSSL) {
        # Native exe stderr / non-zero would surface as NativeCommandError (esp. with $ErrorActionPreference Stop).
        $savedEap = $ErrorActionPreference
        $savedNativeErr = $null
        if (Get-Variable -Name 'PSNativeCommandUseErrorActionPreference' -ErrorAction SilentlyContinue) {
            $savedNativeErr = $PSNativeCommandUseErrorActionPreference
            $PSNativeCommandUseErrorActionPreference = $false
        }
        $ErrorActionPreference = 'SilentlyContinue'
        $Error.Clear()

        # Try OpenSSL 1.1+ with SAN (-addext). Older OpenSSL: retry without it.
        $keyPath = "$certsDir\localhost.key"
        $crtPath = "$certsDir\localhost.crt"
        $pfxPath = "$certsDir\localhost.pfx"
        $reqArgs1 = @(
            'req', '-x509', '-newkey', 'rsa:2048', '-keyout', $keyPath, '-out', $crtPath,
            '-days', '365', '-nodes', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
        )
        $null = & openssl @reqArgs1 2>&1 | Out-Null
        if (($LASTEXITCODE -ne 0) -or -not (Test-Path -LiteralPath $crtPath)) {
            if (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $crtPath) { Remove-Item -LiteralPath $crtPath -Force -ErrorAction SilentlyContinue }
            $reqArgs2 = @(
                'req', '-x509', '-newkey', 'rsa:2048', '-keyout', $keyPath, '-out', $crtPath,
                '-days', '365', '-nodes', '-subj', '/CN=localhost'
            )
            $null = & openssl @reqArgs2 2>&1 | Out-Null
        }
        if (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $crtPath)) {
            $p12Args = @(
                'pkcs12', '-export', '-out', $pfxPath, '-inkey', $keyPath, '-in', $crtPath,
                "-passout", "pass:$CertPassword", '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'
            )
            $null = & openssl @p12Args 2>&1 | Out-Null
            if (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $pfxPath)) {
                $opensslProducedCerts = $true
            }
        }

        $ErrorActionPreference = $savedEap
        if ($null -ne $savedNativeErr) {
            $PSNativeCommandUseErrorActionPreference = $savedNativeErr
        }
        $Error.Clear()
    }

    if ($opensslProducedCerts) {
        Write-Host "    certs\localhost.crt OK" -ForegroundColor Green
        Write-Host "    certs\localhost.pfx OK" -ForegroundColor Green
    } else {
        if ($hasOpenSSL) {
            Write-Host "    openssl did not complete successfully (or options unsupported); using PowerShell to generate certificates..." -ForegroundColor Yellow
        } else {
            Write-Host "    openssl not found, using PowerShell certificate generation..."
        }
        New-DevPilotLocalhostCertsPowerShell -CertsDir $certsDir -PfxPasswordPlain $CertPassword
        Write-Host "    certs\localhost.crt OK" -ForegroundColor Green
        Write-Host "    certs\localhost.pfx OK" -ForegroundColor Green
    }
} else {
    $pfxPath = Join-Path $certsDir "localhost.pfx"
    if (-not (Test-Path $pfxPath)) {
        Write-Host "ERROR: certs\localhost.pfx not found. Remove -NoCerts to generate." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "==> Using existing certificates in certs\"
}

# --- Trust certificate (Windows) --------------------------------------------
if ($TrustCert) {
    Write-Host ""
    Write-Host "==> Trusting certificate in Windows store (may require elevation)..."
    $crtPath = Join-Path $certsDir "localhost.crt"
    try {
        Import-Certificate -FilePath $crtPath -CertStoreLocation "Cert:\LocalMachine\Root" -ErrorAction Stop | Out-Null
        Write-Host "    Certificate trusted OK" -ForegroundColor Green
    } catch {
        Write-Host "    WARNING: Could not trust certificate. Run as Administrator to trust." -ForegroundColor Yellow
    }
}

# --- Write .env file ---------------------------------------------------------
Write-Host ""
Write-Host "==> Writing .env file..."
$envContent = @"
# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
IDS_PORT=$Port
CERT_PASSWORD=$CertPassword
ADMIN_USERNAME=$Username
ADMIN_PASSWORD=$AdminPassword
ADMIN_EMAIL=$Email
ADMIN_DISPLAY_NAME=$DisplayName
REDIS_PORT=6379
"@
Set-Content -Path ".env" -Value $envContent -Encoding UTF8
Write-Host "    .env OK" -ForegroundColor Green

# --- Update blazor-appsettings.json with the correct port --------------------
Write-Host ""
Write-Host "==> Updating blazor-appsettings.json for port $Port..."
$blazorPath = Join-Path $ScriptDir "blazor-appsettings.json"
if (Test-Path $blazorPath) {
    $blazor = Get-Content $blazorPath -Raw | ConvertFrom-Json
    $base = "https://localhost:$Port"
    $blazor.apiBaseUrl = "$base/api"
    $blazor.providerOptions.authority = "$base/"
    $blazor.providerOptions.redirectUri = "$base/authentication/login-callback"
    $blazor.providerOptions.postLogoutRedirectUri = "$base/authentication/logout-callback"
    $blazor.settingsOptions.apiUrl = "$base/api/api/configuration"
    $blazor | ConvertTo-Json -Depth 10 | Set-Content $blazorPath -Encoding UTF8
}
Write-Host "    blazor-appsettings.json OK" -ForegroundColor Green

# --- Stop existing and start containers --------------------------------------
Write-Host ""
Write-Host "==> Starting containers..."
docker compose down --remove-orphans -v 2>$null
docker compose up -d

# --- Wait for health ---------------------------------------------------------
Write-Host ""
Write-Host "==> Waiting for Identity Server to be ready..."
$maxWait = 60
$elapsed = 0
while ($elapsed -lt $maxWait) {
    try {
        # PowerShell skip cert validation for health check
        if ($PSVersionTable.PSVersion.Major -ge 7) {
            $response = Invoke-WebRequest -Uri "https://localhost:$Port/.well-known/openid-configuration" -SkipCertificateCheck -TimeoutSec 3 -ErrorAction SilentlyContinue
        } else {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            $response = Invoke-WebRequest -Uri "https://localhost:$Port/.well-known/openid-configuration" -TimeoutSec 3 -ErrorAction SilentlyContinue
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $null
        }
        if ($response.StatusCode -eq 200) { break }
    } catch {
        # ignore TLS/connection errors until timeout
    }
    Start-Sleep -Seconds 2
    $elapsed += 2
}

if ($elapsed -ge $maxWait) {
    Write-Host "    WARNING: Server did not become ready within ${maxWait}s." -ForegroundColor Yellow
    Write-Host "    Check logs: docker logs devpilot-duende"
} else {
    Write-Host "    Identity Server is ready OK" -ForegroundColor Green
}

# --- Done --------------------------------------------------------------------
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  DevPilot Identity Server is running!" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Admin UI       : https://localhost:$Port"
Write-Host "  OIDC Discovery : https://localhost:$Port/.well-known/openid-configuration"
Write-Host ""
Write-Host "  Admin login"
Write-Host "    Username : $Username" -ForegroundColor Yellow
Write-Host "    Password : $AdminPassword" -ForegroundColor Yellow
Write-Host ""
Write-Host "  OIDC Client ID : devpilot-spa"
Write-Host ""
if (-not $TrustCert) {
    Write-Host "  NOTE: The self-signed certificate is NOT trusted by your OS." -ForegroundColor DarkYellow
    Write-Host "  Your browser will show a warning. To trust it, re-run with:" -ForegroundColor DarkYellow
    Write-Host "    .\install.ps1 -NoCerts -TrustCert" -ForegroundColor DarkYellow
    Write-Host ""
}
Write-Host "======================================================================" -ForegroundColor Cyan
