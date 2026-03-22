#!/usr/bin/env bash
# Run *inside* ubuntu:24.04 with the host Docker socket mounted at /var/run/docker.sock
# (Docker Desktop Linux containers). Called by Windows setup.ps1, infra/local/setup.ps1, k8s/setup-local.ps1.
set -euo pipefail

export DOCKER_BUILDKIT=1

echo '[DEBUG] apt-get update...' | tee build.log
apt-get update 2>&1 | tee -a build.log
echo '[DEBUG] apt-get install docker.io curl wget git...' | tee -a build.log
apt-get install -y docker.io curl wget git 2>&1 | tee -a build.log
echo '[DEBUG] running setup.sh...' | tee -a build.log
bash setup.sh 2>&1 | tee -a build.log
