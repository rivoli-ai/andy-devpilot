# Enterprise / Corporate Certificates

This is the **single, centralized** location for custom root CA certificates
used across the entire DevPilot stack (backend, sandbox-manager, sandbox
desktop containers, and identity server).

Place your corporate proxy or SSL-inspection root CA `.crt` / `.pem` files
here. They will be:

1. **Baked into images at build time** — backend and sandbox-desktop
   Dockerfiles `COPY` from this directory and run `update-ca-certificates`.
2. **Mounted into containers at runtime** — `docker-compose.yml` bind-mounts
   this directory so you can update certs without rebuilding images.

## Supported formats

- `.crt` (PEM-encoded, preferred)
- `.pem` (PEM-encoded)
- `.cer` (PEM or DER — PEM preferred)

## How to export your Zscaler / corporate root CA

### macOS
```bash
security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain > certs/ZscalerRootCA.crt
```

### Windows (PowerShell)
```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object {$_.Subject -like "*Zscaler*"} |
    ForEach-Object { [System.IO.File]::WriteAllText("certs\ZscalerRootCA.crt",
        "-----BEGIN CERTIFICATE-----`n" +
        [Convert]::ToBase64String($_.RawData, [System.Base64FormattingOptions]::InsertLineBreaks) +
        "`n-----END CERTIFICATE-----") }
```

### Linux
```bash
cp /usr/local/share/ca-certificates/ZscalerRootCA.crt certs/
```

### From browser (any OS)
1. Visit any HTTPS site (e.g. https://nuget.org)
2. Click the lock icon -> Certificate -> Details
3. Select the **root** certificate (topmost in the chain)
4. Export as PEM / Base64-encoded and save to this folder

## After adding certificates

For the fastest path, just restart:
```bash
# Linux / macOS
./start.sh

# Windows
.\start.ps1
```

Runtime-mounted certs are picked up on container restart. For build-time
embedding (sandbox desktop image), add `-Rebuild`:
```bash
.\start.ps1 -Rebuild
```
