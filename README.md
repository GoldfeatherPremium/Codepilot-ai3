# CodePilot AI — Monorepo

The complete CodePilot AI product: the SaaS platform and its execution backend, deployed as two services.

```
platform/         Next.js 15 app + Supabase backend (database, edge functions, docs)
sandbox-runner/   Docker execution service for agent terminal commands
```

## What each piece is

**`platform/`** — the product itself. Next.js 15 frontend (landing, auth, dashboard, agent chat with live thinking timeline, repositories, tasks, PRs, memory explorer, providers, settings, billing, admin), three PostgreSQL migrations (17 tables, pgvector, forced RLS, SQL functions), and six Supabase Edge Functions (`agent-run` orchestration, `github-sync`, `provider-test`, `memory-embed`, `ai-chat`, `github-webhook`). Start with `platform/README.md`; full setup in `platform/docs/DEPLOYMENT.md`, system design in `platform/docs/ARCHITECTURE.md`, threat model in `platform/docs/SECURITY.md`.

**`sandbox-runner/`** — the isolated command-execution service that `agent-run` calls when an agent has terminal permission. Express + dockerode + BullMQ: per-job Docker containers (Node 20, Python 3.12, PHP 8.3, Go 1.23, Rust) with CPU/RAM/PID/disk limits, repo cloning with the user's GitHub token, real-time SSE log streaming, diff/commit/push, automatic teardown, bearer auth, and rate limiting. Deployment guide for Ubuntu 24.04 (Contabo) is in `sandbox-runner/README.md`.

## How they connect

One shared secret links them. The platform's edge functions call the runner over HTTPS:

```bash
# Runner side (sandbox-runner/.env)
SANDBOX_RUNNER_TOKEN=<openssl rand -hex 32>

# Platform side (Supabase secrets)
supabase secrets set SANDBOX_RUNNER_URL="https://sandbox.yourdomain.com"
supabase secrets set SANDBOX_RUNNER_TOKEN="<same value>"
```

`agent-run` POSTs `/exec` with `{repo, branch, command, timeout_seconds, staged_files, github_token}`; the runner returns `{exit_code, stdout, stderr, sandbox_id, timed_out}`, which lands in `execution_logs` and the chat timeline. The runner is optional — without it, agents simply can't execute commands; everything else (planning, editing, commits, PRs, memory) works.

## Deploy order

1. Supabase project + migrations + edge functions (`platform/docs/DEPLOYMENT.md` §1–6)
2. Frontend to Vercel (§7)
3. Sandbox runner to a VPS (`sandbox-runner/README.md`) and set the two Supabase secrets
