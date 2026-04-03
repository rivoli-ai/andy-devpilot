# Local stage — certs/ from build context (repo root when: docker build -f ... .)
FROM scratch AS certs
COPY certs/ /

FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Trust enterprise CAs at build time so pip install works behind corporate proxies
COPY --from=certs / /usr/local/share/ca-certificates/corporate/
RUN find /usr/local/share/ca-certificates/corporate/ \( -name '.gitkeep' -o -name '.gitignore' -o -name 'README.md' \) -delete 2>/dev/null || true && \
    update-ca-certificates
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    MANAGER_BIND_HOST=0.0.0.0

# Build context must be the repository root (see docker-compose / azure-pipelines).
COPY infra/sandbox/manager/requirements.txt .
RUN pip install --no-cache-dir \
    --trusted-host pypi.org \
    --trusted-host files.pythonhosted.org \
    -r requirements.txt

COPY infra/sandbox/manager/manager.py infra/sandbox/manager/k8s_utils.py infra/sandbox/manager/cleanup.py ./
COPY infra/sandbox/manager/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8090

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "manager.py"]
