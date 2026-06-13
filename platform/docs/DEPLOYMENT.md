# CodePilot AI — Deployment Guide

This guide takes you from zero to a running production deployment: Supabase project, database, edge functions, OAuth apps, webhook, and the Next.js frontend.

## 1. Create the Supabase project

Create a project at https://supabase.com/dashboard. Note the project ref, the URL, the `anon` key, and the `service_role` key. Then link the local repo:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

## 2. Apply database migrations

The three migrations create the schema, RLS policies, and SQL functions, in that order:

```bash
supabase db push
```

This enables the `vector`, `pgcrypto`, and `pg_trgm` extensions, creates all 17 tables, forces RLS, revokes secret columns from client roles, and adds the tables to the Realtime publication. Verify in the dashboard that **Database → Replication** shows `agent_messages`, `agent_runs`, `agent_tasks`, and `execution_logs` in the `supabase_realtime` publication.

## 3. Configure auth providers

In **Authentication → Providers**:

GitHub — create an OAuth app at https://github.com/settings/developers with callback URL `https://<PROJECT_REF>.supabase.co/auth/v1/callback`. Paste the client id and secret into Supabase. The app requests scopes `read:user user:email repo` at sign-in (set in the frontend, not here).

Google — create OAuth credentials in Google Cloud Console with the same Supabase callback URL and paste them in.

In **Authentication → URL Configuration**, set the Site URL to your production domain and add `https://<your-domain>/auth/callback` to the redirect allow-list (plus `http://localhost:3000/auth/callback` for development).

## 4. Set edge function secrets

```bash
# 32-byte AES master key for encrypting provider keys and GitHub tokens
supabase secrets set ENCRYPTION_MASTER_KEY="$(openssl rand -base64 32)"

# Shared secret for verifying GitHub webhooks (use the same value in step 6)
supabase secrets set GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"

# Optional: external sandbox runner for terminal execution
supabase secrets set SANDBOX_RUNNER_URL="https://sandbox.yourdomain.com"
supabase secrets set SANDBOX_RUNNER_TOKEN="<runner auth token>"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. Treat `ENCRYPTION_MASTER_KEY` like a root credential: losing it makes every stored key unrecoverable, and rotating it requires re-encrypting (users can simply re-add keys and reconnect GitHub).

## 5. Deploy edge functions

```bash
supabase functions deploy agent-run
supabase functions deploy github-sync
supabase functions deploy provider-test
supabase functions deploy memory-embed
supabase functions deploy ai-chat
supabase functions deploy github-webhook --no-verify-jwt
```

The webhook function is deployed with `--no-verify-jwt` because GitHub cannot send a Supabase JWT; it authenticates with an HMAC signature instead.

## 6. Register the GitHub webhook

For each organization (or per repository), add a webhook pointing to
`https://<PROJECT_REF>.supabase.co/functions/v1/github-webhook`, content type `application/json`, secret equal to `GITHUB_WEBHOOK_SECRET`, subscribed to **Pull requests** and **Pushes**.

## 7. Deploy the frontend

Copy `.env.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

Locally: `npm install && npm run dev`. For production, push to GitHub and import the repo into Vercel, adding the same two environment variables. The middleware, server components, and edge-function calls all derive from these; the service-role key is never used by the frontend.

## 8. Sandbox runner (terminal execution)

`execute_command` delegates to an external runner so untrusted commands never execute inside the edge runtime. Any service that accepts `POST {command, timeout}` with a bearer token and returns `{stdout, stderr, exit_code}` works — a small Fly.io/Firecracker app, a gVisor-backed container service, or E2B. If `SANDBOX_RUNNER_URL` is unset, agents with execute permission receive a clear "sandbox not configured" tool error and continue without it.

## 9. First-run checklist

Sign in with GitHub, confirm Settings shows the connection as active, add an AI provider key under AI Providers and test it (an OpenAI key additionally enables embeddings for code search and memory), import a repository and let the sync finish, create an agent with conservative permissions, and give it a small task. You should see the plan card, and after approval, the live timeline, a branch, a commit, and a pull request.

## 10. Promote an admin

```sql
update public.users set role = 'admin' where email = 'you@example.com';
```

Run this in the SQL editor (clients cannot self-escalate — RLS blocks role changes). The Admin page and `admin_metrics` RPC become available immediately.
