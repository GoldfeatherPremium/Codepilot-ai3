# CodePilot AI

An AI software-engineering agent platform: connect a GitHub repository, configure an agent with your own AI provider key and granular permissions, describe a task — the agent proposes a plan, waits for your approval, then reads the codebase, edits files on a dedicated branch, runs sandboxed commands, commits, and opens a pull request, streaming its thinking live and remembering what it learns permanently.

## Features

**Agents & orchestration** — multiple agents per user, each with its own model, system prompt, repository binding, iteration cap, and five independently toggled permissions (read, edit, commit, PR, execute). Tasks always go plan → human approval → execution; nothing runs unapproved.

**GitHub integration** — OAuth with `repo` scope, repository import and background indexing (branches, commits, languages, open PRs, file tree with embeddings), atomic multi-file commits via the Git Data API, agent branches namespaced `codepilot/*`, PRs with summary, diff stats, flagged risks, and testing notes, and a webhook keeping statuses live.

**14 AI providers** — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Groq, Together, Fireworks, Azure OpenAI, AWS Bedrock, Vertex AI, Cohere, Mistral, and Qwen behind one adapter, with per-call cost estimation. Keys are AES-256-GCM encrypted; only the last 4 characters are ever visible.

**Persistent memory** — pgvector-backed memories scoped to user, repository, or task, with pinning (recall boost), recency decay, semantic search, and a full explorer UI for search/pin/recategorize/delete.

**Live chat UI** — markdown rendering, plan approval cards, and a phosphor thinking-timeline streaming every tool call, file edit, and command over Supabase Realtime.

**Platform** — usage and cost tracking with a 30-day chart, billing records and plan tiers, an admin console with system metrics and the audit trail, row-level security on every table, and per-user rate limiting.

## Stack

Next.js 15 (App Router) · TypeScript · TailwindCSS · Supabase (PostgreSQL + pgvector, Edge Functions, Auth, Realtime) · Recharts · Lucide.

## Repository layout

```
supabase/migrations/   00001 schema · 00002 RLS · 00003 SQL functions
supabase/functions/    agent-run · github-sync · provider-test ·
                       memory-embed · ai-chat · github-webhook · _shared/
src/app/               landing · login · auth callback · (dashboard)/…
src/components/        chat (message, plan card, timeline, composer) · ui kit
src/lib/               supabase clients · typed edge-function API · types
docs/                  ARCHITECTURE.md · DEPLOYMENT.md · SECURITY.md
```

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in Supabase URL + anon key
supabase link --project-ref <ref> && supabase db push
supabase secrets set ENCRYPTION_MASTER_KEY="$(openssl rand -base64 32)"
supabase functions deploy agent-run github-sync provider-test memory-embed ai-chat
supabase functions deploy github-webhook --no-verify-jwt
npm run dev
```

Full setup (OAuth apps, webhook, sandbox runner, admin promotion) is in `docs/DEPLOYMENT.md`. The system design is in `docs/ARCHITECTURE.md` and the threat model in `docs/SECURITY.md`.
