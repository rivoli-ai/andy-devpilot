# Custom Certificates

Place your corporate/proxy root CA certificates here **before** running `setup.sh`.

These files are copied into the sandbox container's trust store at build time,
so tools like `dotnet restore`, `npm install`, `curl`, and `git` will trust
HTTPS connections signed by your corporate proxy (e.g. Zscaler).

## Supported formats

- `.crt` (PEM-encoded, preferred)
- `.pem` (PEM-encoded)
- `.cer` (PEM or DER — PEM is preferred)

## How to export your Zscaler / corporate root CA

### macOS
```bash
# Find and export the Zscaler root CA from Keychain
security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain > certs/ZscalerRootCA.crt
```

### Windows (PowerShell)
```powershell
# Export Zscaler root CA from certificate store
Get-ChildItem Cert:\LocalMachine\Root | Where-Object {$_.Subject -like "*Zscaler*"} |
    ForEach-Object { [System.IO.File]::WriteAllText("certs\ZscalerRootCA.crt",
        "-----BEGIN CERTIFICATE-----`n" +
        [Convert]::ToBase64String($_.RawData, [System.Base64FormattingOptions]::InsertLineBreaks) +
        "`n-----END CERTIFICATE-----") }
```

### Linux
```bash
# Copy from system trust store
cp /usr/local/share/ca-certificates/ZscalerRootCA.crt certs/
```

### From browser (any OS)
1. Visit any HTTPS site (e.g. https://nuget.org)
2. Click the lock icon -> Certificate -> Details
3. Select the **root** certificate (topmost in the chain)
4. Export as PEM / Base64-encoded and save to this folder

## After adding certificates

Re-run the setup script:
```bash
sudo ./setup.sh
```
