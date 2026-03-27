#!/bin/bash
set -e

# Trust custom CA certificates mounted at runtime under /certs/
if ls /certs/*.crt 1>/dev/null 2>&1 || \
   ls /certs/*.pem 1>/dev/null 2>&1; then
    cp /certs/*.crt /certs/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
    update-ca-certificates 2>/dev/null || true
fi

exec "$@"
