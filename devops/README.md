# DevPilot — Azure DevOps CI/CD

## Strategy

**No external registry needed.** The pipeline:

1. Builds `devpilot-backend`, `devpilot-frontend`, and `devpilot-manager` images in parallel on the Azure-hosted agent.
2. Exports them as compressed `.tar.gz` artifacts.
3. Copies them to the production server via SSH.
4. Loads the images with `docker load` and restarts the stack with `docker compose`.

```
Azure DevOps agent
  ├── Build backend  ─┐
  ├── Build frontend ─┤──▶ SSH copy ──▶ Production server
  └── Build manager  ─┘               docker load + compose up
```

---

## One-time setup (Azure DevOps)

### 1. SSH Service Connection

- Go to **Project Settings → Service Connections → New → SSH**.
- Fill in the server IP/hostname, user, and password (or private key).
- Name it exactly: `production-server-password`.

### 2. Variable Group (secrets)

- Go to **Pipelines → Library → + Variable Group**.
- Name: `devpilot-production`.
- Add all the variables below and **mark sensitive ones as secret** (🔒).

| Variable | Description | Secret |
|---|---|---|
| `DB_USER` | PostgreSQL username | |
| `DB_PASSWORD` | PostgreSQL password | 🔒 |
| `DB_NAME` | PostgreSQL database name | |
| `JWT_SECRET_KEY` | JWT signing key | 🔒 |
| `MANAGER_API_KEY` | Sandbox manager API key | 🔒 |
| `PUBLIC_IP` | Server's public IP or hostname | |
| `API_URL` | API URL seen by frontend (default `/api`) | |
| `AuthProviders__GitHub__ClientId` | GitHub OAuth client ID | |
| `AuthProviders__GitHub__ClientSecret` | GitHub OAuth secret | 🔒 |
| `AuthProviders__AzureAd__ClientId` | Azure AD client ID | |
| `AuthProviders__AzureAd__ClientSecret` | Azure AD secret | 🔒 |
| `AuthProviders__AzureAd__TenantId` | Azure AD tenant | |
| `AI_ENDPOINT` | LLM endpoint URL | |
| `AI_API_KEY` | LLM API key | 🔒 |
| `AI_MODEL` | LLM model name | |
|| `ADMIN_EMAIL` | Email of the super-admin (gets `admin` JWT role — manages shared AI providers) | |

### 3. Link Variable Group to Pipeline

In `azure-pipelines.yml`, add at the top level under `variables`:

```yaml
variables:
  - group: devpilot-production
  - name: DEPLOY_DIR
    value: /opt/devpilot
  - name: BUILD_DIR
    value: $(Build.ArtifactStagingDirectory)/images
```

### 4. Create Pipeline in Azure DevOps

- Go to **Pipelines → New Pipeline**.
- Select **Azure Repos Git** (or GitHub).
- Select **Existing Azure Pipelines YAML file**.
- Path: `devops/azure-pipelines.yml`.

### 5. Production server prerequisites

On the production server (run once):

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt-get install -y docker-compose-plugin

# Create deployment folder
sudo mkdir -p /opt/devpilot/images
sudo chown $USER:$USER /opt/devpilot
```

### 6. Nginx — HTTPS + sandbox proxy (run once on the server)

The frontend is served over HTTPS. Sandbox VNC and bridge endpoints must also be
reachable over HTTPS to avoid **mixed-content** browser errors.  
Nginx proxies `/sandbox-vnc/<port>/` and `/sandbox-bridge/<port>/` to the
corresponding host port.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Write the config (replace flexagent.online with your domain)
sudo tee /etc/nginx/sites-available/devpilot > /dev/null <<'EOF'
server {
    listen 80;
    server_name flexagent.online;
    # Certbot will add HTTPS redirect automatically
    location / {
        proxy_pass http://localhost:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/devpilot /etc/nginx/sites-enabled/devpilot
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# Issue SSL certificate
sudo certbot --nginx -d flexagent.online --non-interactive --agree-tos -m your@email.com

# After Certbot, add the sandbox proxy blocks into the 443 server block
sudo tee /etc/nginx/snippets/devpilot-sandbox-proxy.conf > /dev/null <<'EOF'
    # ── Sandbox VNC proxy (avoids mixed-content: HTTPS → HTTP) ──────────────
    # Proxies https://domain/sandbox-vnc/<port>/<path> → http://localhost:<port>/<path>
    location ~ ^/sandbox-vnc/(?<sbport>6[0-9]{3})(/.*)? {
        proxy_pass          http://localhost:$sbport$2$is_args$args;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_set_header    Host $host;
        proxy_read_timeout  3600s;
    }

    # ── Sandbox bridge API proxy ─────────────────────────────────────────────
    # Proxies https://domain/sandbox-bridge/<port>/<path> → http://localhost:<port>/<path>
    location ~ ^/sandbox-bridge/(?<sbport>7[0-9]{3})(/.*)? {
        proxy_pass          http://localhost:$sbport$2$is_args$args;
        proxy_http_version  1.1;
        proxy_set_header    Host $host;
        proxy_set_header    X-Real-IP $remote_addr;
        proxy_read_timeout  300s;
    }
EOF

# Inject the snippet into the SSL server block Certbot created
sudo sed -i '/server_name flexagent.online;/a \    include snippets/devpilot-sandbox-proxy.conf;' \
    /etc/nginx/sites-enabled/devpilot

sudo nginx -t && sudo systemctl reload nginx
```

> **Variable group**: set `PUBLIC_IP` to `flexagent.online` (not the raw IP) so that
> `HTTPS_PROXY_BASE=https://flexagent.online` is generated correctly in the `.env`.

---

## Files

| File | Purpose |
|---|---|
| `azure-pipelines.yml` | Full CI/CD pipeline definition |
| `docker-compose.prod.yml` | Production compose file (uses pre-built images) |

---

## Trigger

The pipeline runs automatically on every push to `main`. To trigger manually:

- Go to **Pipelines** → select the pipeline → **Run pipeline**.
