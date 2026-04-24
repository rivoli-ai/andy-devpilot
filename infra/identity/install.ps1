# -----------------------------------------------------------------------------
# DevPilot Identity Server - install script (Windows PowerShell)
# Generates: certs, certs\ca-bundle.crt, .env, blazor-appsettings.json,
#            docker-compose.yml (no macOS/Linux copy required)
#
# Usage:
#   .\install.ps1                           # generate certs + start
#   .\install.ps1 -NoCerts                  # skip cert generation
#   .\install.ps1 -TrustCert                # also trust cert in Windows store
#   .\install.ps1 -Username admin           # override admin username
#   .\install.ps1 -Port 5001                 # override IDS port
#   .\install.ps1 -KeepVolumes               # "down" without -v (if volume removal hangs on Windows)
# -----------------------------------------------------------------------------
param(
    [switch]$NoCerts,
    [switch]$TrustCert,
    [int]$Port = 5001,
    [string]$Username = "ibenamara",
    [string]$Email = $null,
    [string]$DisplayName = $null,
    [string]$CertPassword = "devpassword",
    [switch]$KeepVolumes,
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
  -KeepVolumes   docker compose down without removing volumes (use if "down" hangs on Windows)
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

# Compose V2: "docker compose". Older setups: "docker-compose" (v1) on PATH only.
$eapForCompose = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$Error.Clear()
$null = & docker compose version 2>&1
$useDockerComposePlugin = ($LASTEXITCODE -eq 0)
$Error.Clear()
$ErrorActionPreference = $eapForCompose
$dockerComposeV1 = $null
if ($useDockerComposePlugin) {
    Write-Host "    docker compose (Compose v2) OK" -ForegroundColor Green
} else {
    $dockerComposeV1 = Get-Command docker-compose -ErrorAction SilentlyContinue
    if ($dockerComposeV1) {
        $dockerComposeV1 = $dockerComposeV1.Path
        Write-Host "    docker-compose (Compose v1) OK" -ForegroundColor Green
    } else {
        Write-Host "ERROR: Compose not found. This script needs either 'docker compose' (Docker Compose v2 plugin) or the 'docker-compose' (v1) program on PATH." -ForegroundColor Red
        Write-Host "  Install/update Docker Desktop, or enable the Compose v2 plugin, or install legacy docker-compose and add it to PATH." -ForegroundColor Yellow
        exit 1
    }
}

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

# --- Build CA bundle for container (replaces the image trust store; same idea as install.sh) ----
Write-Host ""
Write-Host "==> Building CA bundle for container..."
$caBundlePath = Join-Path $certsDir "ca-bundle.crt"
$bundleText = $null
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $eap0 = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $caTemp = [System.IO.Path]::GetTempFileName()
    $null = & curl.exe -fsSL "https://curl.se/ca/cacert.pem" -o $caTemp 2>&1
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $caTemp) -and ((Get-Item -LiteralPath $caTemp).Length -gt 1000)) {
        $bundleText = [System.IO.File]::ReadAllText($caTemp)
    }
    if (Test-Path -LiteralPath $caTemp) { Remove-Item -LiteralPath $caTemp -Force -ErrorAction SilentlyContinue }
    $ErrorActionPreference = $eap0
}
if ($null -eq $bundleText) {
    foreach ($cand in @(
        (Join-Path $env:ProgramFiles "Git\mingw64\etc\ssl\certs\ca-bundle.crt"),
        (Join-Path $env:ProgramFiles "Git\usr\ssl\cert.pem")
    )) {
        if (Test-Path -LiteralPath $cand) {
            $bundleText = [System.IO.File]::ReadAllText($cand)
            break
        }
    }
}
if ($null -eq $bundleText) { $bundleText = "" }
$localhostCrtForBundle = Join-Path $certsDir "localhost.crt"
$bundleText += [Environment]::NewLine + [Environment]::NewLine + "# DevPilot localhost self-signed" + [Environment]::NewLine
$bundleText += [System.IO.File]::ReadAllText($localhostCrtForBundle)
$entDirs = @(
    (Join-Path $ScriptDir "enterprise-certs"),
    (Join-Path (Split-Path $ScriptDir) "sandbox\certs")
)
foreach ($ed in $entDirs) {
    if (-not (Test-Path -LiteralPath $ed)) { continue }
    Get-ChildItem -LiteralPath $ed -File -ErrorAction SilentlyContinue | ForEach-Object {
        $fn = $_.Name
        if ($fn -notmatch '\.(crt|pem)$') { return }
        if ($fn -like "localhost*") { return }
        $bundleText += [Environment]::NewLine + [Environment]::NewLine + "# Enterprise: $fn" + [Environment]::NewLine
        $bundleText += [System.IO.File]::ReadAllText($_.FullName)
    }
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($caBundlePath, $bundleText, $utf8NoBom)
$certCount = [regex]::Matches($bundleText, "BEGIN CERTIFICATE").Count
Write-Host "    certs\ca-bundle.crt OK ($certCount certificates)" -ForegroundColor Green
if ($certCount -lt 2) {
    Write-Host "    NOTE: For a full public CA set, use Git for Windows ca-bundle, or run install with network (curl) available." -ForegroundColor DarkGray
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

# --- Remove Docker-created empty dirs (when a mount target was missing) ------
foreach ($stale in @("blazor-appsettings.json", "docker-compose.yml", "init.sh")) {
    $sp = Join-Path $ScriptDir $stale
    if ((Test-Path -LiteralPath $sp) -and (Get-Item -LiteralPath $sp -ErrorAction SilentlyContinue) -is [System.IO.DirectoryInfo]) {
        Write-Host "    Removed stale directory: $stale" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $sp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Generate blazor-appsettings.json (same content as install.sh) ----------
Write-Host ""
$base = "https://localhost:$Port"
$blazorPath = Join-Path $ScriptDir "blazor-appsettings.json"
Write-Host "==> Generating blazor-appsettings.json for port $Port..."
$blazorContent = @"
{
  "prerendered": true,
  "administratorEmail": "$Email",
  "apiBaseUrl": "$base/api",
  "loggingOptions": {
    "minimum": "Warning"
  },
  "authenticationPaths": {
    "remoteRegisterPath": "/identity/account/register",
    "remoteProfilePath": "/identity/account/manage"
  },
  "userOptions": {
    "roleClaim": "role"
  },
  "providerOptions": {
    "authority": "$base/",
    "clientId": "theidserveradmin",
    "defaultScopes": [
      "openid",
      "profile",
      "theidserveradminapi"
    ],
    "postLogoutRedirectUri": "$base/authentication/logout-callback",
    "redirectUri": "$base/authentication/login-callback",
    "responseType": "code"
  },
  "welcomeContenUrl": "/api/welcomefragment",
  "settingsOptions": {
    "typeName": "Aguacongas.TheIdServer.BlazorApp.Models.ServerConfig, Aguacongas.TheIdServer.BlazorApp.Infrastructure",
    "apiUrl": "$base/api/api/configuration"
  },
  "menuOptions": {
    "showSettings": true
  }
}
"@
$utf8NoBom2 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($blazorPath, $blazorContent, $utf8NoBom2)
Write-Host "    blazor-appsettings.json OK" -ForegroundColor Green

# --- Generate docker-compose.yml (same as install.sh; .env provides variables)-
Write-Host ""
Write-Host "==> Generating docker-compose.yml..."
$composeYml = @'
services:
  redis:
    image: redis:7
    container_name: devpilot-redis
    ports:
      - "${REDIS_PORT:-6379}:6379"
    restart: always
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 10
      start_period: 5s

  duende:
    image: aguacongas/theidserver.duende:6.0.0
    container_name: devpilot-duende
    platform: linux/amd64
    ports:
      - "${IDS_PORT:-5001}:${IDS_PORT:-5001}"
    environment:
      # -- Kestrel / HTTPS
      ASPNETCORE_URLS: "https://+:${IDS_PORT:-5001}"
      ASPNETCORE_Kestrel__Certificates__Default__Path: "/certs/localhost.pfx"
      ASPNETCORE_Kestrel__Certificates__Default__Password: "${CERT_PASSWORD:-devpassword}"

      # -- Storage
      RedisConfigurationOptions__ConnectionString: "redis:6379,abortConnect=False"
      DbType: "Sqlite"
      ConnectionStrings__DefaultConnection: "Data Source=/data/theidserver.db"
      Seed: "true"

      # -- IdentityServer issuer and internal API auth
      IdentityServer__IssuerUri: "https://localhost:${IDS_PORT:-5001}"
      ApiAuthentication__Authority: "https://localhost:${IDS_PORT:-5001}"
      ApiAuthentication__RequireHttpsMetadata: "false"
      PrivateServerAuthentication__Authority: "https://localhost:${IDS_PORT:-5001}"
      PrivateServerAuthentication__ApiUrl: "https://localhost:${IDS_PORT:-5001}/api"
      PrivateServerAuthentication__HeathUrl: "https://localhost:${IDS_PORT:-5001}/healthz"
      PrivateServerAuthentication__RequireHttpsMetadata: "false"

      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt"

      # -- Admin Blazor SPA
      InitialData__Clients__0__ClientId: "theidserveradmin"
      InitialData__Clients__0__ClientName: "DevPilot Admin UI"
      InitialData__Clients__0__ClientClaimsPrefix: ""
      InitialData__Clients__0__AllowedGrantTypes__0: "authorization_code"
      InitialData__Clients__0__RequirePkce: "true"
      InitialData__Clients__0__RequireClientSecret: "false"
      InitialData__Clients__0__BackChannelLogoutSessionRequired: "false"
      InitialData__Clients__0__FrontChannelLogoutSessionRequired: "false"
      InitialData__Clients__0__AccessTokenType: "Reference"
      InitialData__Clients__0__RedirectUris__0: "https://localhost:${IDS_PORT:-5001}/authentication/login-callback"
      InitialData__Clients__0__PostLogoutRedirectUris__0: "https://localhost:${IDS_PORT:-5001}/authentication/logout-callback"
      InitialData__Clients__0__AllowedCorsOrigins__0: "https://localhost:${IDS_PORT:-5001}"
      InitialData__Clients__0__AllowedScopes__0: "openid"
      InitialData__Clients__0__AllowedScopes__1: "profile"
      InitialData__Clients__0__AllowedScopes__2: "theidserveradminapi"

      # -- DevPilot SPA
      InitialData__Clients__2__ClientId: "devpilot-spa"
      InitialData__Clients__2__ClientName: "DevPilot SPA"
      InitialData__Clients__2__ClientClaimsPrefix: ""
      InitialData__Clients__2__AllowedGrantTypes__0: "authorization_code"
      InitialData__Clients__2__RequirePkce: "true"
      InitialData__Clients__2__RequireClientSecret: "false"
      InitialData__Clients__2__AllowAccessTokensViaBrowser: "true"
      InitialData__Clients__2__AccessTokenType: "Jwt"
      InitialData__Clients__2__FrontChannelLogoutSessionRequired: "false"
      InitialData__Clients__2__BackChannelLogoutSessionRequired: "false"
      InitialData__Clients__2__RedirectUris__0: "http://localhost:4200/auth/callback/Duende"
      InitialData__Clients__2__PostLogoutRedirectUris__0: "http://localhost:4200"
      InitialData__Clients__2__AllowedCorsOrigins__0: "http://localhost:4200"
      InitialData__Clients__2__AllowedScopes__0: "openid"
      InitialData__Clients__2__AllowedScopes__1: "profile"
      InitialData__Clients__2__AllowedScopes__2: "email"

      # -- Admin user
      InitialData__Users__0__UserName: "${ADMIN_USERNAME:-admin}"
      InitialData__Users__0__Email: "${ADMIN_EMAIL:-admin@devpilot.local}"
      InitialData__Users__0__EmailConfirmed: "true"
      InitialData__Users__0__Password: "${ADMIN_PASSWORD:-DevPilot123!}"
      InitialData__Users__0__Roles__0: "Is4-Writer"
      InitialData__Users__0__Roles__1: "Is4-Reader"
      InitialData__Users__0__Claims__0__ClaimType: "name"
      InitialData__Users__0__Claims__0__ClaimValue: "${ADMIN_DISPLAY_NAME:-DevPilot Admin}"
      InitialData__Users__0__Claims__1__ClaimType: "given_name"
      InitialData__Users__0__Claims__1__ClaimValue: "${ADMIN_USERNAME:-admin}"
      InitialData__Users__0__Claims__2__ClaimType: "email"
      InitialData__Users__0__Claims__2__ClaimValue: "${ADMIN_EMAIL:-admin@devpilot.local}"

    volumes:
      - duende-data:/data
      - ./certs:/certs:ro
      - ./blazor-appsettings.json:/app/wwwroot/appsettings.json:ro
      - ./certs/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro
    depends_on:
      redis:
        condition: service_healthy
    restart: always

volumes:
  duende-data:
'@
$composeFile = Join-Path $ScriptDir "docker-compose.yml"
[System.IO.File]::WriteAllText($composeFile, $composeYml + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
Write-Host "    docker-compose.yml OK" -ForegroundColor Green

# --- Verify files before start -----------------------------------------------
Write-Host ""
Write-Host "==> Verifying certificate files..."
foreach ($req in @("localhost.crt", "localhost.pfx", "ca-bundle.crt")) {
    $rp = Join-Path $certsDir $req
    if (-not (Test-Path -LiteralPath $rp)) {
        Write-Host "ERROR: $req not found in certs\. Re-run this script to generate or repair files." -ForegroundColor Red
        exit 1
    }
    Write-Host "    certs\$req OK" -ForegroundColor Green
}

# --- Stop existing and start containers --------------------------------------
Write-Host ""
Write-Host "==> Starting containers..."
Write-Host "    (Image pulls on first run can take several minutes - progress appears below.)" -ForegroundColor DarkGray
# Docker writes to stderr; PS 7 + ErrorAction Stop surfaces NativeCommandError. Relax for docker only.
# Do not pipe docker output to Out-Null: large pulls would look stuck and pipes can add delay.
$saveEap = $ErrorActionPreference
$saveNativeErr = $null
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $saveNativeErr = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
}
$ErrorActionPreference = 'SilentlyContinue'
$Error.Clear()

if ($useDockerComposePlugin) {
    $downArgs = @('compose', 'down', '--remove-orphans', '-t', '10')
} else {
    $downArgs = @('down', '--remove-orphans', '-t', '10')
}
if (-not $KeepVolumes) { $downArgs += '-v' }
Write-Host "    Stopping previous stack (if any)..."
if ($useDockerComposePlugin) {
    $null = & docker @downArgs
} else {
    $null = & $dockerComposeV1 @downArgs
}
# Ignore down exit: nothing to stop is not an error

Write-Host "    Pulling images..."
if ($useDockerComposePlugin) {
    $null = & docker compose pull
} else {
    $null = & $dockerComposeV1 @('pull')
}
$composePullExit = $LASTEXITCODE
if ($composePullExit -ne 0) {
    $ErrorActionPreference = $saveEap
    if ($null -ne $saveNativeErr) { $PSNativeCommandUseErrorActionPreference = $saveNativeErr }
    Write-Host "ERROR: docker compose / docker-compose pull failed (exit $composePullExit). Check network and Docker Hub access." -ForegroundColor Red
    exit 1
}

Write-Host "    Starting services..."
if ($useDockerComposePlugin) {
    $null = & docker compose up -d
} else {
    $null = & $dockerComposeV1 @('up', '-d')
}
$composeUpExit = $LASTEXITCODE

$ErrorActionPreference = $saveEap
if ($null -ne $saveNativeErr) {
    $PSNativeCommandUseErrorActionPreference = $saveNativeErr
}
$Error.Clear()
if ($composeUpExit -ne 0) {
    Write-Host "ERROR: docker compose / docker-compose up -d failed (exit $composeUpExit). Is Docker running and the port free?" -ForegroundColor Red
    exit 1
}

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
