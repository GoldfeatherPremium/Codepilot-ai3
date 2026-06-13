# CodePilot AI — Architecture

CodePilot AI is an AI software-engineering agent platform. Users connect GitHub repositories, configure agents with their own AI provider keys and granular permissions, and assign tasks. Agents plan first, wait for human approval, then read code, edit files, run sandboxed commands, commit to a dedicated branch, and open a pull request — streaming their activity live to the UI and persisting what they learn into long-term memory.

## System overview

The system has three tiers. The **Next.js 15 app** (App Router, deployed on Vercel or any Node host) renders the UI, holds the Supabase session via `@supabase/ssr` cookies, and reads data directly from PostgreSQL through PostgREST under row-level security. The **Supabase Edge Functions** (Deno) are the privileged backend: they hold the service-role key and the AES master key, talk to GitHub and the 14 AI providers, and are the only place where secrets are ever decrypted. **PostgreSQL** (with pgvector) is the source of truth: 17 tables, RLS on everything, SQL functions for semantic search and metrics, and Realtime replication of `agent_messages`, `agent_runs`, `agent_tasks`, and `execution_logs` so the chat UI updates live without polling.

```
Browser ──(RLS reads, Realtime)──► Supabase PostgreSQL + pgvector
   │                                        ▲
   └──(JWT)──► Edge Functions ──────────────┘ (service role)
                   │ ├── GitHub REST API (encrypted OAuth token)
                   │ ├── 14 AI providers (encrypted user keys)
                   │ └── Sandbox runner (isolated command execution)
```

The frontend never calls GitHub or an AI provider directly. Everything privileged flows through five edge functions: `agent-run` (orchestration), `github-sync` (import/index), `provider-test` (key management), `memory-embed` (memory CRUD + search), `github-webhook` (PR/push events), plus `ai-chat` for streaming completions.

## Agent orchestration flow

A task moves through an explicit state machine: `pending → planning → awaiting_approval → approved → running → completed | failed`, with `rejected` and `cancelled` as exits.

1. **Plan.** The user submits a prompt in Task mode. `agent-run` recalls relevant memories via `match_memories`, then asks the model for a strict-JSON plan (`{title, steps[]}`). The task is stored with status `awaiting_approval` and the plan renders in the chat as an approval card. Nothing executes yet.
2. **Approve.** On approval, the function creates a working branch (`codepilot/{task-id}-{slug}`) off the default branch, inserts an `agent_runs` row, and starts the run loop in the background with `EdgeRuntime.waitUntil` so the HTTP response returns immediately.
3. **Run loop.** Up to `agents.max_iterations`, the model is called with a toolbox filtered by the agent's permission flags: `search_codebase`, `read_file`, `list_directory` (read), `write_file`, `delete_file` (edit — staged in memory, not pushed), `commit_changes` (atomic multi-file commit via the Git Data API), `create_pull_request` (PR with summary, files changed, risks, and testing notes), `execute_command` (delegated to the external sandbox runner, fully logged), `save_memory`, `update_step`, and `finish`. Every event is appended to `agent_runs.timeline`, which Realtime streams to the thinking-timeline component. Token counts and cost are accumulated per iteration via `record_usage`.
4. **Finish.** The `finish` tool writes a result summary, flips task and run statuses, and the PR (if any) is linked back to the task.

Permission enforcement happens server-side on every tool dispatch — a model cannot call a tool its agent wasn't granted, regardless of what it generates.

## Memory architecture

Memories live in `agent_memories` with three scopes — `user` (preferences that follow the person everywhere), `repository` (project structure, schema knowledge, past changes), and `task` (ephemeral working context) — and eleven categories (coding preference, architecture preference, previous change, important file, and so on). Each memory stores a 1536-dimension embedding (OpenAI `text-embedding-3-small`) indexed with HNSW.

Recall is the `match_memories` SQL function: cosine similarity, multiplied by a relevance score, boosted 1.25× for pinned memories, and decayed over 90 days of inactivity so stale context fades naturally. `touch_memory` records each access and nudges relevance back up, giving frequently useful memories staying power. The Memory page exposes the whole store: semantic search, pin/unpin, recategorize, and hard delete (an audited operation).

## GitHub integration

Sign-in with GitHub requests `read:user user:email repo`. The OAuth callback hands the provider token to `github-sync`'s `store_token` action, which encrypts it with AES-256-GCM before it touches the database; the ciphertext columns are revoked from the `anon` and `authenticated` roles, so no client can ever read them — only edge functions running as service role.

Repository sync pulls languages, branches, the 30 most recent commits, and open PRs, then walks the tree recursively (skipping `node_modules`, build output, vendored code), indexes source files into `repository_files`, and embeds the ~150 most important ones (entry points, schemas, configs score higher). Code search is hybrid: 65% semantic similarity + 35% path trigram match, which catches both "where is auth handled" and "auth.ts". A webhook endpoint (HMAC-verified) keeps PR statuses and branch heads current without polling.

## AI provider abstraction

A single `complete()` adapter in `_shared/providers.ts` normalizes all 14 providers. OpenAI-wire-compatible providers (OpenAI, DeepSeek, OpenRouter, Groq, Together, Fireworks, Mistral, Qwen, Azure) share one code path with a base-URL map; Anthropic, Gemini/Vertex, Cohere, and Bedrock (SigV4 via aws4fetch) get dedicated translators. Tool definitions and tool calls are normalized to one internal shape, so the agent loop is provider-agnostic. A pricing table estimates cost per call for usage tracking. Keys are stored AES-256-GCM encrypted with only the last four characters retained in plaintext for display; `provider-test` verifies a key with a one-token completion before marking it active.

## Data model (17 tables)

`users` (profile, role, plan, encrypted GitHub token), `repositories`, `repository_branches`, `repository_files` (with embeddings), `agents` (model, prompt, five permission booleans, iteration cap), `agent_tasks` (prompt, JSON plan, approval audit fields, branch), `agent_runs` (status, timeline, tokens, cost), `agent_messages` (chat history), `agent_memories`, `provider_configs`, `commits`, `pull_requests` (diff stats, risks, testing notes), `execution_logs` (command, output, exit code, sandbox id), `usage_tracking`, `billing_records`, `audit_logs`, and `rate_limits` (sliding-window buckets).

## Realtime & UI

The chat page subscribes to one channel filtered by agent id and receives message inserts, task transitions, and run timeline updates as they happen. The thinking timeline renders `agent_runs.timeline` as a vertical rail whose newest node pulses amber while the run is live — the product's signature element. The design system is a near-black "instrument panel": hairline borders, JetBrains Mono for anything machine-generated, and a phosphor-amber accent reserved exclusively for agent activity so a glance tells you whether the machine is working.
