# Enterprise CA Certificates

If your enterprise uses SSL interception (Zscaler, Netskope, corporate proxy, etc.),
place your root CA `.crt` or `.pem` files in this folder before running `install.sh`.

## How to get your enterprise CA cert

### From browser (easiest):
1. Open https://google.com in your browser
2. Click the lock icon → Certificate → Details
3. Find the root CA (top of chain) — it's usually your company name
4. Export/download it as a `.crt` or `.pem` file
5. Place it in this folder

### From command line:
```bash
# This extracts the full cert chain from a known host
openssl s_client -showcerts -connect google.com:443 < /dev/null 2>/dev/null | \
  awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > enterprise-ca.crt
```

Then re-run `./install.sh`.

The certs in this folder are also shared with the sandbox setup at `../sandbox/certs/`.
