#!/usr/bin/env bash
# ============================================================================
# CodePilot Sandbox Runner — one-shot installer for Ubuntu 24.04 (Contabo VPS)
# Target hardware profile: 6 vCPU / 16 GB RAM / NVMe.
#
# What it does:
#   1. System hardening: UFW (SSH+80+443 only), fail2ban, unattended upgrades
#   2. Docker Engine + compose plugin
#   3. xfs loopback volume with pquota for per-container disk limits
#   4. Builds the multi-language sandbox image
#   5. Generates .env with a fresh SANDBOX_RUNNER_TOKEN (printed once)
#   6. Starts runner + Redis via docker compose, installs the systemd unit
#   7. Installs the cron healthcheck
#
# Usage (as root or with sudo, from the repo root):
#   sudo bash deploy/install.sh [--skip-quota] [--domain sandbox.example.com]
# ============================================================================
set -euo pipefail

SKIP_QUOTA=0
DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-quota) SKIP_QUOTA=1; shift ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
echo "==> Installing from $REPO_DIR"

# --- 1. Hardening ------------------------------------------------------------
echo "==> System packages & hardening"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades curl ca-certificates xfsprogs jq openssl

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null   # ACME challenges
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null

# --- 2. Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker >/dev/null

# --- 3. xfs pquota volume for per-container disk limits ----------------------------
if [[ "$SKIP_QUOTA" == "0" ]]; then
  if ! mount | grep -q "/var/lib/docker type xfs"; then
    echo "==> Creating 80G xfs loopback volume with pquota for /var/lib/docker"
    systemctl stop docker
    if [[ ! -f /docker-data.img ]]; then
      fallocate -l 80G /docker-data.img
      mkfs.xfs -q /docker-data.img
    fi
    mkdir -p /var/lib/docker
    grep -q '/docker-data.img' /etc/fstab || \
      echo '/docker-data.img /var/lib/docker xfs loop,pquota 0 0' >> /etc/fstab
    mount -a
    systemctl start docker
  fi
  docker info 2>/dev/null | grep -q 'overlay2' || echo "WARN: overlay2 not active — disk quotas may not apply"
else
  echo "==> --skip-quota: per-container disk limits will be best-effort (tmpfs cap only)"
fi

# --- 4. Build images ------------------------------------------------------------------
echo "==> Building sandbox image (Node 20 / Python 3.12 / PHP 8.3 / Go 1.23 / Rust)"
docker build -q -t codepilot-sandbox:latest ./sandbox-image

# --- 5. .env ----------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  TOKEN="$(openssl rand -hex 32)"
  cat > .env <<ENVEOF
SANDBOX_RUNNER_TOKEN=${TOKEN}
# Sized for 6 vCPU / 16 GB: 4 concurrent jobs × (1 CPU + 1.5 GB) leaves
# headroom for the host, Redis, and the runner itself.
SANDBOX_CPUS=1
SANDBOX_MEMORY_MB=1536
SANDBOX_DISK_MB=4096
SANDBOX_PIDS_LIMIT=256
SANDBOX_NETWORK=bridge
MAX_CONCURRENT_JOBS=4
MAX_SESSIONS=12
SESSION_TTL_SECONDS=1800
RATE_LIMIT_PER_MINUTE=120
LOG_LEVEL=info
ENVEOF
  chmod 600 .env
  echo ""
  echo "============================================================"
  echo "  SANDBOX_RUNNER_TOKEN (set this as a Supabase secret too):"
  echo "  ${TOKEN}"
  echo "============================================================"
  echo ""
else
  echo "==> .env exists — keeping current token and limits"
fi

# --- 6. Start + systemd ---------------------------------------------------------------------
echo "==> Starting runner + Redis"
docker compose up -d --build

sed "s|__REPO_DIR__|${REPO_DIR}|g" deploy/codepilot-runner.service > /etc/systemd/system/codepilot-runner.service
systemctl daemon-reload
systemctl enable codepilot-runner.service >/dev/null

# --- 7. Cron healthcheck -----------------------------------------------------------------------
install -m 0755 deploy/healthcheck.sh /usr/local/bin/codepilot-healthcheck
( crontab -l 2>/dev/null | grep -v codepilot-healthcheck; echo "*/2 * * * * /usr/local/bin/codepilot-healthcheck >/dev/null 2>&1" ) | crontab -

# --- 8. Optional TLS via Caddy ---------------------------------------------------------------------
if [[ -n "$DOMAIN" ]]; then
  echo "==> Installing Caddy for TLS on ${DOMAIN}"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy.list
  apt-get update -qq && apt-get install -y -qq caddy
  sed "s|sandbox.yourdomain.com|${DOMAIN}|" deploy/Caddyfile > /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "==> TLS endpoint: https://${DOMAIN}"
fi

echo ""
echo "==> Verifying"
sleep 3
curl -fsS localhost:8080/healthz && echo ""
echo "==> Done. Next:"
echo "    supabase secrets set SANDBOX_RUNNER_URL='https://${DOMAIN:-<your-domain>}'"
echo "    supabase secrets set SANDBOX_RUNNER_TOKEN='<token above>'"
