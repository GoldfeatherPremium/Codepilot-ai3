# CodePilot Sandbox Runner

The execution backend for CodePilot AI agents. It receives jobs from the Supabase Edge Functions, spins up an isolated Docker container per job or session, clones the user's GitHub repository with their token, runs commands under hard CPU/RAM/PID/disk limits, streams logs in real time over SSE, produces diffs, commits, pushes branches, and destroys every container automatically — behind bearer-token auth, a Redis-backed job queue (BullMQ), and per-client rate limiting.

## How it fits the platform

`agent-run` (Supabase Edge Function) calls `POST /exec` with the bearer token from `SANDBOX_RUNNER_TOKEN`. The same secret value is configured on both sides. The payload includes the repo, the agent's working branch, the command, the agent's staged-but-uncommitted file edits, and the user's GitHub token (server-to-server over TLS only). The runner clones, overlays the staged files, executes, and returns `{exit_code, stdout, stderr, sandbox_id, timed_out}` — exactly the shape `execute_command` expects and logs into `execution_logs`.

```
Edge Function ──Bearer token──► Runner API ──BullMQ──► Worker ──dockerode──► sandbox container
                                    │                                            │
                                    └── SSE log stream ◄── Redis pub/sub ◄──────┘
```

Sandboxes are based on `codepilot-sandbox:latest` (Ubuntu 24.04 with **Node.js 20, Python 3.12, PHP 8.3, Go 1.23, and Rust stable**), run as a non-root user with all capabilities dropped, `no-new-privileges`, no swap, a PID cap, a tmpfs `/tmp`, and an overlay disk quota where the storage driver supports it.

## API

Primary resource paths are `/sandboxes/*` (the former `/sessions/*` paths remain as a compatible alias). All endpoints except `/healthz` require `Authorization: Bearer <SANDBOX_RUNNER_TOKEN>` and are rate-limited (default 60 req/min per client, sliding window in Redis).

**`POST /exec`** — one-shot execution (what the edge function uses). Creates a container, optionally clones `repo` at `branch` using `github_token`, writes `staged_files`, runs `command` with `timeout_seconds` (capped at 600), then destroys the container regardless of outcome.

```json
// request
{ "repo": "owner/repo", "branch": "codepilot/abc-fix", "command": "npm test",
  "timeout_seconds": 300, "staged_files": {"src/a.ts": "..."}, "github_token": "gho_..." }
// response
{ "exit_code": 0, "stdout": "...", "stderr": "", "sandbox_id": "Vx3k9q2LmP4a",
  "timed_out": false, "duration_ms": 41250 }
```

**`POST /sessions`** — create a persistent sandbox (clone once, run many commands). Returns `{session_id}`. Idle sessions are reaped after `SESSION_TTL_SECONDS`.

**`POST /sessions/:id/exec`** — run a command in the session. With `"async": true` it returns `202 {job_id, stream_url}` immediately; otherwise it blocks and returns the result.

**`GET /sessions/:id/exec/:jobId/stream`** — Server-Sent Events. Emits `log` events (`{stream: "stdout"|"stderr", data, at}`) in real time — including a backlog for late subscribers — and a final `done` event with the job result.

**`GET /sessions/:id/diff`** — `{diff, files: [{path, status, additions, deletions}]}` of the working tree vs HEAD (untracked files included).

**`POST /sessions/:id/commit`** — `{message, author_name?, author_email?}` → `{sha, files_changed}`.

**`POST /sessions/:id/push`** — `{branch, github_token?}` → pushes with `--set-upstream origin`, using the session's token if none is supplied.

**`DELETE /sessions/:id`** — destroy immediately.

**`GET /metrics`** — authenticated monitoring: queue counts, per-sandbox CPU/RAM stats, configured limits, Docker engine info, uptime.

**`GET /healthz`** — unauthenticated liveness (`{ok, sessions}`); checks Docker reachability.

### Security properties

The GitHub token is injected per git command as an `http.extraHeader` sourced from an environment variable — it never appears in argv, the remote URL, on disk inside the container, or in output (token patterns are additionally redacted from all captured streams and logs). Staged-file paths are validated against traversal. Bearer comparison is constant-time over SHA-256 digests. Output capture is capped (`MAX_OUTPUT_BYTES`, default 1 MB/stream). Containers are labeled and force-removed: on job completion, on session TTL, on graceful shutdown, and orphans are swept on startup.

---

## Deployment — Ubuntu 24.04 on Contabo

**Automated:** on a fresh VPS, `sudo bash deploy/install.sh --domain sandbox.yourdomain.com` performs every step below — hardening + UFW + fail2ban, Docker, the xfs/pquota volume, both image builds, `.env` with a fresh token (printed once), compose + systemd unit, the cron healthcheck, and Caddy TLS. `deploy/update.sh` handles upgrades. The manual steps remain documented for operators who want to understand or customize each piece.

These steps assume a fresh Contabo VPS (the 4-core/8 GB tier comfortably runs `MAX_CONCURRENT_JOBS=4`) with a domain you control. Total time: ~20 minutes.

### 1. Base hardening

SSH in as root, then:

```bash
apt update && apt -y upgrade
adduser deploy && usermod -aG sudo deploy
rsync -a ~/.ssh /home/deploy/ && chown -R deploy:deploy /home/deploy/.ssh

# Firewall: SSH + HTTPS only. The runner itself binds to 127.0.0.1.
apt -y install ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 443/tcp && ufw allow 80/tcp   # 80 for ACME challenges
ufw enable

# Disable root SSH + password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Continue as `deploy`.

### 2. Install Docker Engine

```bash
sudo apt -y install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker deploy && newgrp docker
```

### 3. (Recommended) Enable per-container disk quotas

`--storage-opt size=` works with the overlay2 driver only when `/var/lib/docker` sits on **xfs mounted with `pquota`**. Contabo VPS images use ext4 by default, so create an xfs volume from a loopback file (or attach Contabo block storage and format it xfs):

```bash
sudo apt -y install xfsprogs
sudo fallocate -l 60G /docker-data.img
sudo mkfs.xfs /docker-data.img
sudo mkdir -p /var/lib/docker
echo '/docker-data.img /var/lib/docker xfs loop,pquota 0 0' | sudo tee -a /etc/fstab
sudo systemctl stop docker && sudo mount -a && sudo systemctl start docker
docker info | grep -A2 'Storage Driver'   # expect overlay2 on xfs
```

If you skip this, the runner detects the rejected option and creates containers **without** the disk quota (everything else still applies) — the tmpfs `/tmp` cap and shallow clones keep growth modest, but a hostile job could fill the disk, so the quota is worth the five minutes.

### 4. Build images and configure

```bash
git clone <your-fork-of-this-repo> codepilot-sandbox-runner
cd codepilot-sandbox-runner

# The multi-language sandbox image (one-time, ~5 min)
docker build -t codepilot-sandbox:latest ./sandbox-image

cp .env.example .env
openssl rand -hex 32   # → paste as SANDBOX_RUNNER_TOKEN in .env
```

### 5. Run

```bash
docker compose up -d --build
curl -s localhost:8080/healthz   # {"ok":true,"sessions":0}
```

Compose runs the runner (bound to 127.0.0.1:8080) and Redis, with `restart: unless-stopped` so both survive reboots.

### 6. TLS with Caddy

```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy.list
sudo apt update && sudo apt -y install caddy

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy
```

Point a DNS A record (e.g. `sandbox.yourdomain.com`) at the VPS IP; Caddy obtains and renews the certificate automatically.

### 7. Connect Supabase

```bash
supabase secrets set SANDBOX_RUNNER_URL="https://sandbox.yourdomain.com"
supabase secrets set SANDBOX_RUNNER_TOKEN="<the same token from .env>"
supabase functions deploy agent-run
```

Verify end-to-end:

```bash
curl -s https://sandbox.yourdomain.com/exec \
  -H "Authorization: Bearer $SANDBOX_RUNNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"node -v && python3 -V && php -v | head -1 && go version && rustc -V"}'
```

Then give an agent with execute permission a task like "run the test suite" — the command, output, exit code, and sandbox id will appear in `execution_logs` and the chat timeline.

### 8. Operations

Logs: `docker compose logs -f runner`. Update: `git pull && docker compose up -d --build`. Rebuild the sandbox image after changing toolchains: `docker build -t codepilot-sandbox:latest ./sandbox-image && docker compose restart runner`. Scale: raise `MAX_CONCURRENT_JOBS`/`MAX_SESSIONS` with CPU/RAM (rule of thumb: 1 core + 1–1.5 GB per concurrent job), or run several runner VPSes behind DNS round-robin — sessions are per-instance, but the `/exec` one-shot path the platform uses is fully stateless.

### Threat model note

The runner mounts the host Docker socket to create sibling sandbox containers — the standard, simple pattern for a **dedicated** runner host. Keep this VPS single-purpose: nothing else should run on it, and only the edge functions should hold the token. For a stronger boundary later, the same API can be backed by gVisor (`runsc` as the container runtime, a one-line daemon.json change) or Firecracker VMs without touching the platform side.
