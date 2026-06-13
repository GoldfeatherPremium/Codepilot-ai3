#!/usr/bin/env bash
# Zero-fuss update: pull, rebuild both images, restart. Run from repo root.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git pull --ff-only
docker build -t codepilot-sandbox:latest ./sandbox-image
docker compose up -d --build
sleep 3
curl -fsS localhost:8080/healthz && echo " — updated OK"
