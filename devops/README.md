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
