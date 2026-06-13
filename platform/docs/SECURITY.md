# CodePilot AI — Security Model

## Trust boundaries

The browser is untrusted: it holds only a user JWT and the public anon key, and everything it can read or write is constrained by row-level security. Edge functions are the privileged tier: they run with the service-role key and the AES master key, and they re-derive the calling user from the `Authorization` header on every request (`requireUser`) before doing anything on that user's behalf. The sandbox runner is semi-trusted: it executes arbitrary agent commands, so it lives outside the platform entirely, behind its own token, with no database access.

## Row-level security

RLS is enabled **and forced** on all 17 tables, so even table owners go through policies. The model is strict ownership: every top-level row carries `user_id`, and child rows (files, branches, commits) are scoped through their parent repository. Two deliberate asymmetries: users may update their own profile but a `with check` clause prevents changing `role` or `plan` (no self-escalation), and admin visibility is granted only through the `is_admin()` security-definer function used by `admin_metrics` and audit policies.

## Secrets at rest

Three classes of secrets never exist in plaintext in the database: GitHub OAuth tokens, AI provider API keys, and the webhook secret (which lives only in edge-function env). Tokens and keys are encrypted with AES-256-GCM using a random 12-byte IV per value; the master key is a 32-byte secret held exclusively in edge-function environment. Defense in depth on top of encryption: the ciphertext and IV columns are explicitly `REVOKE`d from the `anon` and `authenticated` Postgres roles, so even a policy mistake cannot leak them through PostgREST. Clients see only `key_last4` for display.

## Agent permission enforcement

Each agent carries five booleans — read repo, edit repo, create commits, create PRs, execute commands — and the orchestrator filters the toolbox **before** the model sees it and re-checks the flag on every dispatch. Edits are staged in memory and only reach GitHub through an explicit `commit_changes` call on a dedicated `codepilot/*` branch, never the default branch. No task executes anything until a human approves the plan; approval is recorded with the approver's id and timestamp.

## Command execution

`execute_command` is the highest-risk capability, so it is off by default, runs only in the external sandbox (never in the edge runtime), is bounded by the run's iteration cap and a timeout, and every invocation is persisted to `execution_logs` with the full command, stdout/stderr, exit code, and sandbox id, plus an audit entry.

## Audit and rate limiting

`audit_logs` records security-relevant events — key added/removed, GitHub connected, repo imported, task approved/rejected, PR created, command executed, memory deleted, role changed — via the `write_audit` function. Rate limiting is a sliding-window upsert in `rate_limits`, enforced inside edge functions per user per bucket (e.g. 30 agent operations/hour, 60 syncs/hour, 120 chat calls/hour), returning HTTP 429 when exceeded.

## Webhook authenticity

The GitHub webhook endpoint verifies `X-Hub-Signature-256` with HMAC SHA-256 using a constant-time comparison before parsing the payload; unsigned or mismatched requests are rejected with 401.

## Transport and headers

All traffic is TLS (Supabase and Vercel terminate HTTPS). The Next.js config sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a strict referrer policy, and a restrictive permissions policy. OAuth callback redirects are validated to be same-origin relative paths to prevent open redirects.

## Residual risks worth knowing

Prompt injection from repository content is mitigated structurally (permission gating, plan approval, branch isolation, sandboxing) rather than eliminated — an agent reading a hostile README can be influenced, but it cannot exceed its granted tools or touch the default branch. The `repo` OAuth scope is broad by GitHub's design; organizations wanting tighter grants should install a GitHub App variant with per-repo permissions. And the master encryption key is a single point of compromise: store it only in Supabase secrets, never in the repo or frontend env.
