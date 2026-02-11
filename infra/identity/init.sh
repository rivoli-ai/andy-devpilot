#!/bin/sh
# Trust the self-signed localhost cert + any enterprise certs inside the container
cp /certs/localhost.crt /usr/local/share/ca-certificates/localhost.crt 2>/dev/null || true

# Copy enterprise certs if any
if [ -d /enterprise-certs ]; then
  for f in /enterprise-certs/*.crt /enterprise-certs/*.pem; do
    [ -f "$f" ] && cp "$f" /usr/local/share/ca-certificates/ 2>/dev/null || true
  done
fi

update-ca-certificates 2>/dev/null || true

# Start the application (exec replaces shell process)
exec dotnet Aguacongas.TheIdServer.Duende.dll
