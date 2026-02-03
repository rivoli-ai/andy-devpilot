# VPS Setup Guide - DevPilot

Detailed guide for configuring a VPS to run DevPilot sandbox infrastructure.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Provision a VPS](#step-1-provision-a-vps)
3. [Step 2: Initial Server Configuration](#step-2-initial-server-configuration)
4. [Step 3: Install Docker](#step-3-install-docker)
5. [Step 4: Security Configuration](#step-4-security-configuration)
6. [Step 5: Deploy Sandbox Manager](#step-5-deploy-sandbox-manager)
7. [Step 6: Configure Application](#step-6-configure-application)
8. [Step 7: Test Connection](#step-7-test-connection)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- VPS with Ubuntu 22.04 LTS (2 CPU, 4GB RAM minimum)
- SSH access to the server
- Domain name (optional, for HTTPS)

---

## Step 1: Provision a VPS

### Recommended Providers

| Provider | Config | Price |
|----------|--------|-------|
| **Hetzner Cloud** | 4GB RAM, 2 vCPUs | ~$14/month |
| **DigitalOcean** | 4GB RAM, 2 vCPUs | ~$24/month |
| **Linode** | 4GB RAM, 2 vCPUs | ~$24/month |
| **AWS EC2** | t3.medium | ~$30/month |
| **Azure VM** | Standard_B2s | ~$30/month |

### Minimum Requirements

- **RAM**: 4GB (8GB recommended for production)
- **CPU**: 2 vCPUs
- **Storage**: 40GB SSD
- **OS**: Ubuntu 22.04 LTS

Once created, note the **public IP address**.

---

## Step 2: Initial Server Configuration

### 2.1 SSH Connection

```bash
ssh root@YOUR_VPS_IP
```

### 2.2 Update System

```bash
apt update && apt upgrade -y
```

### 2.3 Create Sudo User (Recommended)

```bash
# Create user
adduser devpilot

# Add to sudo group
usermod -aG sudo devpilot

# Switch to new user
su - devpilot
```

### 2.4 Set Timezone

```bash
sudo timedatectl set-timezone UTC
```

---

## Step 3: Install Docker

### 3.1 Install Docker Engine

```bash
# Remove old versions
sudo apt remove docker docker-engine docker.io containerd runc 2>/dev/null

# Install prerequisites
sudo apt install -y ca-certificates curl gnupg

# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 3.2 Configure Docker

```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Start Docker on boot
sudo systemctl enable docker
sudo systemctl start docker

# Verify installation
docker --version
docker run hello-world
```

---

## Step 4: Security Configuration

### 4.1 Configure Firewall (UFW)

```bash
# Install UFW if not present
sudo apt install -y ufw

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow 22/tcp

# Allow sandbox manager
sudo ufw allow 8090/tcp

# Allow sandbox noVNC ports
sudo ufw allow 6100:6200/tcp

# Enable firewall
sudo ufw enable

# Verify rules
sudo ufw status
```

### 4.2 SSH Hardening (Optional)

```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config

# Recommended settings:
# PermitRootLogin no
# PasswordAuthentication no
# PubkeyAuthentication yes

# Restart SSH
sudo systemctl restart sshd
```

---

## Step 5: Deploy Sandbox Manager

### 5.1 Create Directory Structure

```bash
sudo mkdir -p /opt/devpilot-sandbox
cd /opt/devpilot-sandbox
```

### 5.2 Upload Setup Script

Copy the `sandbox/setup.sh` from your local machine:

```bash
# From your local machine
scp sandbox/setup.sh devpilot@YOUR_VPS_IP:/opt/devpilot-sandbox/
```

Or download directly:

```bash
curl -o setup.sh https://raw.githubusercontent.com/YOUR_REPO/DevPilot/main/sandbox/setup.sh
```

### 5.3 Run Setup

```bash
sudo chmod +x setup.sh
sudo ./setup.sh
```

This will:
1. Build the desktop Docker image
2. Create the sandbox manager service
3. Configure systemd
4. Start the service

### 5.4 Verify Deployment

```bash
# Check service status
sudo systemctl status devpilot-sandbox

# Check logs
sudo journalctl -u devpilot-sandbox -f

# Test API
curl http://localhost:8090/health
```

---

## Step 6: Configure Application

### 6.1 Backend Configuration

Edit `src/API/appsettings.Development.json`:

```json
{
  "VPS": {
    "GatewayUrl": "http://YOUR_VPS_IP:8090",
    "SessionTimeoutMinutes": 60,
    "Enabled": true
  }
}
```

Replace `YOUR_VPS_IP` with your actual VPS IP address.

### 6.2 Environment Variables (Optional)

For production, use environment variables:

```bash
export VPS__GatewayUrl="http://YOUR_VPS_IP:8090"
export VPS__Enabled="true"
```

---

## Step 7: Test Connection

### 7.1 From Your Local Machine

```bash
# Test sandbox manager
curl http://YOUR_VPS_IP:8090/health
# Expected: {"status": "ok"}

# List sandboxes
curl http://YOUR_VPS_IP:8090/sandboxes
# Expected: []
```

### 7.2 Create Test Sandbox

```bash
curl -X POST http://YOUR_VPS_IP:8090/sandboxes \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://github.com/octocat/Hello-World.git",
    "repo_name": "Hello-World",
    "repo_branch": "master"
  }'
```

### 7.3 Access Test Sandbox

Open in browser: `http://YOUR_VPS_IP:6100/vnc.html`

You should see the XFCE desktop with Zed IDE.

### 7.4 Cleanup Test Sandbox

```bash
curl -X DELETE http://YOUR_VPS_IP:8090/sandboxes/SANDBOX_ID
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check logs
sudo journalctl -u devpilot-sandbox -n 100 --no-pager

# Check if port is in use
sudo lsof -i :8090
sudo netstat -tlnp | grep 8090

# Restart service
sudo systemctl restart devpilot-sandbox
```

### Docker Issues

```bash
# Check Docker status
sudo systemctl status docker

# Check if image exists
docker images | grep devpilot

# Rebuild image
cd /opt/devpilot-sandbox
docker build -t devpilot-desktop ./desktop
```

### Firewall Issues

```bash
# Check UFW status
sudo ufw status verbose

# Allow specific port
sudo ufw allow 8090/tcp

# Check if port is reachable
nc -zv YOUR_VPS_IP 8090
```

### Container Issues

```bash
# List containers
docker ps -a --filter "name=sandbox-"

# View container logs
docker logs CONTAINER_ID

# Shell into container
docker exec -it CONTAINER_ID bash

# Remove stuck containers
docker rm -f $(docker ps -aq --filter "name=sandbox-")
```

### DNS/Network Issues

```bash
# Test from inside container
docker exec CONTAINER_ID curl -I https://github.com

# Check DNS resolution
docker exec CONTAINER_ID nslookup github.com
```

---

## Maintenance

### Daily Tasks

```bash
# Check disk space
df -h

# Check running containers
docker ps
```

### Weekly Tasks

```bash
# Clean up unused Docker resources
docker system prune -f

# Check logs for errors
journalctl -u devpilot-sandbox --since "1 week ago" | grep -i error
```

### Monthly Tasks

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Update Docker images
docker pull ubuntu:24.04

# Rebuild sandbox image
cd /opt/devpilot-sandbox
docker build --no-cache -t devpilot-desktop ./desktop
```

---

## Next Steps

- Set up HTTPS with Let's Encrypt
- Configure monitoring (Prometheus/Grafana)
- Set up automated backups
- Configure log rotation

For more details, see [VPS_SANDBOX_CONNECTION_GUIDE.md](VPS_SANDBOX_CONNECTION_GUIDE.md).
