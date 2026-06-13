#!/usr/bin/env bash
# Quick re-deploy: pull latest code, rebuild, and reload PM2 with zero downtime.
# Run on the VPS as root: bash /opt/codepilot-ai/redeploy.sh
set -euo pipefail

APP_NAME="codepilot-ai"
APP_DIR="/opt/codepilot-ai"
BRANCH="build-fixes"
ENV_FILE="$APP_DIR/platform/.env.production"

echo "[redeploy] Pulling latest code..."
git -C "$APP_DIR" fetch origin
git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" reset --hard "origin/$BRANCH"

echo "[redeploy] Installing dependencies..."
cd "$APP_DIR/platform"
npm ci --prefer-offline 2>&1 | grep -v "^npm warn"

echo "[redeploy] Building..."
set -a; source "$ENV_FILE"; set +a
npm run build

echo "[redeploy] Reloading PM2 (zero-downtime)..."
pm2 reload "$APP_DIR/ecosystem.config.js" --env production
pm2 save

echo "[redeploy] Health check..."
sleep 5
curl -sf http://127.0.0.1:3000/api/health && echo "" && echo "[redeploy] OK"
