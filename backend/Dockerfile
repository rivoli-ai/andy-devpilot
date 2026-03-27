FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# ── SSL / NuGet hardening for corporate environments ────────────────────────────
# Trust corporate root CAs from the centralized certs/ directory (repo root)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=certs . /usr/local/share/ca-certificates/corporate/
RUN echo "=== Backend: corporate CA files (certs/) ===" && \
    ls -la /usr/local/share/ca-certificates/corporate || echo "  (none)" && \
    find /usr/local/share/ca-certificates/corporate/ -name '.gitkeep' -delete 2>/dev/null || true && \
    find /usr/local/share/ca-certificates/corporate/ -name '.gitignore' -delete 2>/dev/null || true && \
    find /usr/local/share/ca-certificates/corporate/ -name 'README.md' -delete 2>/dev/null || true && \
    update-ca-certificates && \
    echo "=== Backend: first few CAs in /etc/ssl/certs ===" && \
    ls -la /etc/ssl/certs | head -n 20

# Environment for .NET / NuGet to be more tolerant of proxy / cert issues
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs \
    DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=0 \
    NUGET_CERT_REVOCATION_MODE=off \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NUGET_SIGNATURE_VERIFICATION=false

# Small diagnostics before publish to help when NuGet/SSL fails
RUN echo "=== Backend: testing HTTPS to api.nuget.org from build container ===" && \
    (curl -v https://api.nuget.org/v3/index.json || echo \"[WARN] curl to api.nuget.org failed\") && \
    echo \"=== Backend: dotnet nuget sources ===\" && \
    (dotnet nuget list source || echo \"[WARN] dotnet nuget list source failed\")

# ------------------------------------------------------------------------------

COPY src/ .

RUN dotnet publish API/DevPilot.API.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /app/publish .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Keep the same relaxed SSL / NuGet settings at runtime for outbound calls
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs \
    DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=0 \
    NUGET_CERT_REVOCATION_MODE=off \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NUGET_SIGNATURE_VERIFICATION=false

EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["dotnet", "DevPilot.API.dll"]
