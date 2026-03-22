#!/usr/bin/env bash
# Run *inside* ubuntu:24.04 on Windows Docker Desktop (host pipe → host daemon).
# Called by infra/sandbox/windows/setup.ps1, infra/local/setup.ps1, k8s/setup-local.ps1.
# Do not run this directly on the host OS — use those scripts.
set -euo pipefail

echo '[DEBUG] apt-get update...' | tee build.log
apt-get update 2>&1 | tee -a build.log
echo '[DEBUG] apt-get install docker.io curl wget git...' | tee -a build.log
apt-get install -y docker.io curl wget git 2>&1 | tee -a build.log
echo '[DEBUG] running setup.sh...' | tee -a build.log
bash setup.sh 2>&1 | tee -a build.log
