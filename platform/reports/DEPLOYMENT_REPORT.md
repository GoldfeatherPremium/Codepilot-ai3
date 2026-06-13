# Deployment Report

**Date:** 2026-06-13  
**Target:** Contabo VPS — `213.99.59.182`  
**Stack:** Next.js 15 · PM2 · Nginx · Self-signed TLS

---

## Deployment Architecture

```
Internet → Nginx :443 (TLS) → localhost:3000 (PM2 cluster, Next.js)
         → Nginx :80 (redirect to HTTPS)
```

## PM2 Configuration

```js
// /opt/codepilot-ai/ecosystem.config.js
{
  name: "codepilot-ai",
  cwd: "/opt/codepilot-ai/platform",
  script: "node_modules/.bin/next",
  args: "start -p 3000",
  instances: "max",           // one worker per CPU core
  exec_mode: "cluster",       // Node.js cluster mode
  max_memory_restart: "512M", // auto-restart if memory exceeded
  restart_delay: 3000,        // wait 3s before restart
  env_file: ".env.production",
  error_file: "/var/log/pm2/codepilot-ai-error.log",
  out_file: "/var/log/pm2/codepilot-ai-out.log",
  merge_logs: true,
}
```

## Nginx Configuration

- HTTP → HTTPS redirect
- TLS 1.2 + 1.3, strong cipher suite
- Gzip compression for text/CSS/JS/JSON
- Static assets: 1-year immutable cache
- WebSocket upgrade support (for Supabase Realtime)
- Health endpoint: `access_log off`
- HSTS header: `max-age=31536000; includeSubDomains`

## Auto-Start on Reboot

```bash
pm2 startup systemd -u root --hp /root
pm2 save
```

PM2 generates a systemd service that runs before the network is up.

## Health Endpoint

`GET /api/health`

```json
{
  "status": "ok",
  "timestamp": "2026-06-13T04:00:00.000Z",
  "uptime": 3600.2,
  "version": "1.0.0"
}
```

Nginx monitors: `location /api/health { access_log off; }`

## Error Handling

| Layer | Behavior |
|-------|---------|
| PM2 | Auto-restart on crash, exponential backoff |
| Next.js | `error.tsx` — client error boundary with retry |
| Next.js | `global-error.tsx` — layout-level catch-all |
| Next.js | `not-found.tsx` — custom 404 page |
| Edge Functions | Try/catch → `json({ error: message }, status)` |

## Logging

| Log | Location |
|-----|---------|
| PM2 stdout | `/var/log/pm2/codepilot-ai-out.log` |
| PM2 stderr | `/var/log/pm2/codepilot-ai-error.log` |
| Nginx access | `/var/log/nginx/access.log` |
| Nginx error | `/var/log/nginx/error.log` |

```bash
# Follow logs
pm2 logs codepilot-ai
tail -f /var/log/nginx/error.log
```

## SSL

Currently using a self-signed certificate (3650-day validity).

**To upgrade to Let's Encrypt** (requires a domain pointing to the VPS):
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
# Auto-renewal is configured by certbot
```

## Environment Variables

Located at: `/opt/codepilot-ai/platform/.env.production`

Required before first launch:
```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
```

After editing:
```bash
pm2 restart codepilot-ai
```

## Operational Commands

```bash
# Status
pm2 status
pm2 show codepilot-ai

# Logs
pm2 logs codepilot-ai --lines 100

# Restart (graceful)
pm2 reload codepilot-ai

# Zero-downtime update
bash /opt/codepilot-ai/redeploy.sh

# Health check
curl -k https://213.99.59.182/api/health

# Nginx status
systemctl status nginx
nginx -t && systemctl reload nginx
```

## Remaining Risks

| Risk | Action |
|------|--------|
| No domain (self-signed cert) | Add domain → `certbot --nginx -d domain.com` |
| No external monitoring | Set up Uptime Robot or similar on `/api/health` |
| PM2 log rotation | Run `pm2 install pm2-logrotate` |
| Single VPS (no HA) | Acceptable for MVP; add load balancer + second VPS for scale |
