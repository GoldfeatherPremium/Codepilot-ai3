#!/usr/bin/env bash
# =============================================================================
# Codepilot-AI  —  Production Deploy Script
# Target: Contabo VPS  213.99.59.182  (Ubuntu/Debian)
# Usage:  Run as root or a sudo-capable user on the VPS
# =============================================================================
set -euo pipefail

APP_NAME="codepilot-ai"
APP_DIR="/opt/codepilot-ai"
APP_PORT=3000
REPO_URL="https://github.com/GoldfeatherPremium/Codepilot-ai3.git"
BRANCH="build-fixes"
NODE_VERSION="20"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERR]${NC}   $*" >&2; }

# ---------------------------------------------------------------------------
# 0. Root / sudo check
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  error "Run this script as root or with sudo."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------
info "Updating system packages..."
apt-get update -qq
apt-get install -y -qq curl git nginx openssl ufw

# ---------------------------------------------------------------------------
# 2. Node.js (via NodeSource)
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].replace("v",""))')" -lt "$NODE_VERSION" ]]; then
  info "Installing Node.js $NODE_VERSION..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
fi
info "Node $(node -v) / npm $(npm -v)"

# ---------------------------------------------------------------------------
# 3. PM2
# ---------------------------------------------------------------------------
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2
fi
info "PM2 $(pm2 -v)"

# ---------------------------------------------------------------------------
# 4. Clone / pull the repository
# ---------------------------------------------------------------------------
if [[ -d "$APP_DIR/.git" ]]; then
  info "Pulling latest code from $BRANCH..."
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  info "Cloning repository into $APP_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# ---------------------------------------------------------------------------
# 5. Environment variables
# ---------------------------------------------------------------------------
ENV_FILE="$APP_DIR/platform/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  warn "No .env.production found — creating template."
  cat > "$ENV_FILE" <<'ENVEOF'
# ============================================================
# REQUIRED — fill in before the app will work correctly
# ============================================================
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY

# ============================================================
# OPTIONAL — set if you use GitHub webhook or agent features
# ============================================================
# GITHUB_WEBHOOK_SECRET=
# SUPABASE_SERVICE_ROLE_KEY=

# ============================================================
# Next.js
# ============================================================
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
ENVEOF
  warn "Edit $ENV_FILE before restarting the app."
else
  info "Found existing $ENV_FILE — skipping template."
fi

# ---------------------------------------------------------------------------
# 6. Install dependencies & build
# ---------------------------------------------------------------------------
cd "$APP_DIR/platform"
info "Installing npm dependencies..."
npm ci --prefer-offline 2>&1 | grep -v "^npm warn"

info "Building Next.js production bundle..."
set -a; source "$ENV_FILE"; set +a
npm run build

# ---------------------------------------------------------------------------
# 7. PM2 ecosystem config
# ---------------------------------------------------------------------------
cat > "$APP_DIR/ecosystem.config.js" <<ECOEOF
module.exports = {
  apps: [
    {
      name: "$APP_NAME",
      cwd: "$APP_DIR/platform",
      script: "node_modules/.bin/next",
      args: "start -p $APP_PORT",
      instances: "max",
      exec_mode: "cluster",
      env_production: {
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      env_file: "$ENV_FILE",
      max_memory_restart: "512M",
      restart_delay: 3000,
      watch: false,
      error_file: "/var/log/pm2/${APP_NAME}-error.log",
      out_file:   "/var/log/pm2/${APP_NAME}-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
ECOEOF

mkdir -p /var/log/pm2

# ---------------------------------------------------------------------------
# 8. Start / reload with PM2
# ---------------------------------------------------------------------------
info "Starting app with PM2..."
if pm2 describe "$APP_NAME" &>/dev/null; then
  pm2 reload ecosystem.config.js --env production
else
  pm2 start ecosystem.config.js --env production
fi
pm2 save

# PM2 startup (auto-start on reboot)
info "Configuring PM2 startup hook..."
PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>&1 | tail -1 || true)
if [[ "$PM2_STARTUP" == sudo* ]]; then
  eval "$PM2_STARTUP"
fi
pm2 save

# ---------------------------------------------------------------------------
# 9. Self-signed TLS certificate (no domain → no Let's Encrypt)
# ---------------------------------------------------------------------------
SSL_DIR="/etc/nginx/ssl/codepilot"
mkdir -p "$SSL_DIR"
if [[ ! -f "$SSL_DIR/cert.pem" ]]; then
  info "Generating self-signed TLS certificate (3650 days)..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$SSL_DIR/key.pem" \
    -out    "$SSL_DIR/cert.pem" \
    -subj   "/C=US/ST=State/L=City/O=CodepilotAI/CN=213.99.59.182" \
    -addext "subjectAltName=IP:213.99.59.182"
  chmod 600 "$SSL_DIR/key.pem"
fi

# ---------------------------------------------------------------------------
# 10. Nginx configuration
# ---------------------------------------------------------------------------
info "Writing Nginx config..."
cat > /etc/nginx/sites-available/codepilot <<NGINXEOF
# HTTP → HTTPS redirect
server {
    listen 80;
    server_name 213.99.59.182 _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name 213.99.59.182 _;

    ssl_certificate     $SSL_DIR/cert.pem;
    ssl_certificate_key $SSL_DIR/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/javascript;
    gzip_min_length 1000;

    # Proxy to Next.js
    location / {
        proxy_pass         http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Static assets — long cache
    location /_next/static/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Health check (also accessible without SSL redirect for monitors)
    location /api/health {
        proxy_pass http://127.0.0.1:$APP_PORT;
        access_log off;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/codepilot /etc/nginx/sites-enabled/codepilot
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx

# ---------------------------------------------------------------------------
# 11. UFW firewall
# ---------------------------------------------------------------------------
info "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw status

# ---------------------------------------------------------------------------
# 12. Health check
# ---------------------------------------------------------------------------
info "Waiting for app to be ready..."
for i in {1..20}; do
  if curl -sf http://127.0.0.1:$APP_PORT/api/health &>/dev/null; then
    break
  fi
  sleep 3
done

info "Running health check..."
HEALTH=$(curl -sf http://127.0.0.1:$APP_PORT/api/health || echo "FAILED")
if echo "$HEALTH" | grep -q '"ok"'; then
  info "Health check passed: $HEALTH"
else
  error "Health check failed. App response: $HEALTH"
  pm2 logs "$APP_NAME" --lines 30 --nostream
  exit 1
fi

# ---------------------------------------------------------------------------
# 13. Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN} Deployment complete!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo "  App URL (HTTPS, self-signed):  https://213.99.59.182"
echo "  App URL (HTTP redirect):       http://213.99.59.182"
echo "  Health endpoint:               https://213.99.59.182/api/health"
echo ""
echo "  PM2 status:                    pm2 status"
echo "  PM2 logs:                      pm2 logs $APP_NAME"
echo "  Nginx logs:                    tail -f /var/log/nginx/error.log"
echo ""
echo -e "${YELLOW}  NOTE: Browser will show a certificate warning because${NC}"
echo -e "${YELLOW}  this uses a self-signed cert (no domain for Let's Encrypt).${NC}"
echo -e "${YELLOW}  Add a domain + run: certbot --nginx -d yourdomain.com${NC}"
echo ""
echo "  Environment vars file:  $ENV_FILE"
echo -e "${YELLOW}  IMPORTANT: Edit that file with your Supabase keys, then run:${NC}"
echo -e "${YELLOW}    pm2 restart $APP_NAME${NC}"
echo ""
