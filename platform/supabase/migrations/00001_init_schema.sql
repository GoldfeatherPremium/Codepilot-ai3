-- ============================================================================
-- CodePilot AI — Core Schema
-- Migration 00001: extensions, enums, tables, relationships, indexes
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;        -- pgvector for semantic memory
create extension if not exists pg_trgm;       -- trigram search for code/file paths

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type user_role          as enum ('user', 'admin');
create type plan_tier          as enum ('free', 'pro', 'team', 'enterprise');
create type ai_provider        as enum (
  'openai','anthropic','gemini','deepseek','openrouter','groq','together',
  'fireworks','azure_openai','aws_bedrock','vertex_ai','cohere','mistral','qwen'
);
create type provider_status    as enum ('unverified','active','invalid','rate_limited');
create type memory_scope       as enum ('user','repository','task');
create type memory_category    as enum (
  'coding_preference','framework_preference','architecture_preference',
  'project_structure','previous_change','important_file','database_schema',
  'completed_task','open_task','conversation','custom'
);
create type task_status        as enum (
  'pending','planning','awaiting_approval','approved','running',
  'completed','failed','cancelled','rejected'
);
create type run_status         as enum ('queued','running','succeeded','failed','cancelled');
create type message_role       as enum ('user','assistant','system','tool');
create type pr_status          as enum ('draft','open','merged','closed');
create type execution_status   as enum ('queued','running','success','failed','timeout','killed');
create type sync_status        as enum ('never','syncing','synced','error');
create type billing_status     as enum ('pending','paid','failed','refunded');
create type audit_action       as enum (
  'login','logout','github_connected','repo_connected','repo_removed','agent_created','agent_updated',
  'agent_deleted','provider_key_added','provider_key_updated','provider_key_deleted',
  'task_approved','task_rejected','pr_created','command_executed','memory_deleted',
  'settings_changed','role_changed'
);

-- ----------------------------------------------------------------------------
-- users (profile table; auth identities live in auth.users)
-- ----------------------------------------------------------------------------
create table public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null unique,
  full_name         text,
  avatar_url        text,
  role              user_role not null default 'user',
  plan              plan_tier not null default 'free',
  github_username   text,
  github_user_id    bigint,
  -- GitHub OAuth token, AES-256-GCM encrypted by edge function (never RLS-readable)
  github_token_ciphertext text,
  github_token_iv   text,
  github_connected_at timestamptz,
  default_provider_config_id uuid, -- FK added after provider_configs exists
  notification_prefs jsonb not null default '{"email_pr": true, "email_task_done": true, "email_task_failed": true}',
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- repositories
-- ----------------------------------------------------------------------------
create table public.repositories (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  github_repo_id    bigint not null,
  full_name         text not null,            -- "owner/repo"
  name              text not null,
  description       text,
  private           boolean not null default false,
  default_branch    text not null default 'main',
  languages         jsonb not null default '{}',  -- { "TypeScript": 73210, ... }
  topics            text[] not null default '{}',
  stars             integer not null default 0,
  size_kb           integer not null default 0,
  clone_url         text not null,
  html_url          text not null,
  sync_status       sync_status not null default 'never',
  sync_error        text,
  last_synced_at    timestamptz,
  indexed_file_count integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, github_repo_id)
);

create table public.repository_branches (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  name              text not null,
  head_sha          text not null,
  is_default        boolean not null default false,
  protected         boolean not null default false,
  created_by_agent  boolean not null default false,
  updated_at        timestamptz not null default now(),
  unique (repository_id, name)
);

create table public.repository_files (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  branch            text not null,
  path              text not null,
  sha               text not null,
  size_bytes        integer not null default 0,
  language          text,
  is_binary         boolean not null default false,
  summary           text,                      -- LLM-generated file summary
  embedding         vector(1536),              -- embedding of summary + symbols
  symbols           jsonb not null default '[]', -- extracted functions/classes/exports
  indexed_at        timestamptz not null default now(),
  unique (repository_id, branch, path)
);

-- ----------------------------------------------------------------------------
-- provider_configs (encrypted API keys)
-- ----------------------------------------------------------------------------
create table public.provider_configs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  provider          ai_provider not null,
  label             text not null,
  -- AES-256-GCM: ciphertext + iv (base64). Encrypted/decrypted only inside
  -- edge functions using ENCRYPTION_MASTER_KEY. Excluded from all client selects.
  key_ciphertext    text not null,
  key_iv            text not null,
  key_last4         text not null,             -- safe display: "…sk42"
  endpoint_url      text,                       -- Azure / Bedrock / Vertex custom endpoints
  region            text,                       -- AWS / GCP region
  default_model     text,
  is_default        boolean not null default false,
  status            provider_status not null default 'unverified',
  last_tested_at    timestamptz,
  test_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, provider, label)
);

alter table public.users
  add constraint users_default_provider_fk
  foreign key (default_provider_config_id)
  references public.provider_configs(id) on delete set null;

-- Only one default provider per user
create unique index provider_configs_one_default
  on public.provider_configs(user_id) where is_default;

-- ----------------------------------------------------------------------------
-- agents
-- ----------------------------------------------------------------------------
create table public.agents (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  repository_id     uuid references public.repositories(id) on delete set null,
  name              text not null,
  description       text,
  system_prompt     text not null default '',
  provider_config_id uuid references public.provider_configs(id) on delete set null,
  model             text not null default 'claude-sonnet-4-6',
  temperature       numeric(3,2) not null default 0.20 check (temperature between 0 and 2),
  max_iterations    integer not null default 30 check (max_iterations between 1 and 100),
  -- Permission system (least privilege; everything off by default except read)
  can_read_repo     boolean not null default true,
  can_edit_repo     boolean not null default false,
  can_create_commits boolean not null default false,
  can_create_prs    boolean not null default false,
  can_execute_commands boolean not null default false,
  is_archived       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- agent_tasks (plan → approve → execute)
-- ----------------------------------------------------------------------------
create table public.agent_tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  agent_id          uuid not null references public.agents(id) on delete cascade,
  repository_id     uuid references public.repositories(id) on delete set null,
  title             text not null,
  prompt            text not null,              -- original user request
  status            task_status not null default 'pending',
  -- Plan: [{ "step": 1, "title": "...", "detail": "...", "status": "pending|running|done|failed" }]
  plan              jsonb,
  plan_approved_at  timestamptz,
  plan_approved_by  uuid references public.users(id),
  rejection_reason  text,
  result_summary    text,
  error             text,
  branch_name       text,
  pull_request_id   uuid,                       -- FK added after pull_requests
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- agent_runs (one LLM-loop execution; a task may have several)
-- ----------------------------------------------------------------------------
create table public.agent_runs (
  id                uuid primary key default gen_random_uuid(),
  task_id           uuid references public.agent_tasks(id) on delete cascade,
  agent_id          uuid not null references public.agents(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  status            run_status not null default 'queued',
  provider          ai_provider,
  model             text,
  iterations        integer not null default 0,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  -- thinking timeline: [{ "at": iso, "type": "thinking|tool_call|tool_result|plan|file_edit", ... }]
  timeline          jsonb not null default '[]',
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- agent_messages (chat history; streamed via Supabase Realtime)
-- ----------------------------------------------------------------------------
create table public.agent_messages (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references public.agents(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete set null,
  run_id            uuid references public.agent_runs(id) on delete set null,
  user_id           uuid not null references public.users(id) on delete cascade,
  role              message_role not null,
  content           text not null default '',
  -- structured parts: file references, code blocks, tool calls, status updates
  parts             jsonb not null default '[]',
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  created_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- agent_memories (persistent, semantically searchable)
-- ----------------------------------------------------------------------------
create table public.agent_memories (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  agent_id          uuid references public.agents(id) on delete cascade,
  repository_id     uuid references public.repositories(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete set null,
  scope             memory_scope not null,
  category          memory_category not null default 'custom',
  title             text not null,
  content           text not null,
  embedding         vector(1536),
  pinned            boolean not null default false,
  relevance_score   real not null default 1.0,   -- decays over time, boosted on recall
  last_accessed_at  timestamptz,
  access_count      integer not null default 0,
  source            text not null default 'agent', -- 'agent' | 'user' | 'system'
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- scope integrity
  constraint memory_scope_target check (
    (scope = 'user') or
    (scope = 'repository' and repository_id is not null) or
    (scope = 'task' and task_id is not null)
  )
);

-- ----------------------------------------------------------------------------
-- commits & pull_requests
-- ----------------------------------------------------------------------------
create table public.commits (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete set null,
  run_id            uuid references public.agent_runs(id) on delete set null,
  sha               text not null,
  branch            text not null,
  message           text not null,
  files_changed     jsonb not null default '[]',  -- [{ "path", "additions", "deletions", "status" }]
  additions         integer not null default 0,
  deletions         integer not null default 0,
  authored_by_agent boolean not null default true,
  github_url        text,
  created_at        timestamptz not null default now(),
  unique (repository_id, sha)
);

create table public.pull_requests (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete set null,
  agent_id          uuid references public.agents(id) on delete set null,
  user_id           uuid not null references public.users(id) on delete cascade,
  github_pr_number  integer,
  title             text not null,
  body              text not null default '',      -- summary, files changed, risks, testing notes
  head_branch       text not null,
  base_branch       text not null,
  status            pr_status not null default 'open',
  files_changed     integer not null default 0,
  additions         integer not null default 0,
  deletions         integer not null default 0,
  risks             jsonb not null default '[]',
  testing_notes     text,
  github_url        text,
  merged_at         timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.agent_tasks
  add constraint agent_tasks_pr_fk
  foreign key (pull_request_id) references public.pull_requests(id) on delete set null;

-- ----------------------------------------------------------------------------
-- execution_logs (sandboxed terminal commands)
-- ----------------------------------------------------------------------------
create table public.execution_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  run_id            uuid references public.agent_runs(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete cascade,
  repository_id     uuid references public.repositories(id) on delete set null,
  command           text not null,
  cwd               text not null default '/workspace',
  status            execution_status not null default 'queued',
  exit_code         integer,
  stdout            text not null default '',
  stderr            text not null default '',
  duration_ms       integer,
  sandbox_id        text,                       -- isolated container/microVM id
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- usage_tracking & billing_records
-- ----------------------------------------------------------------------------
create table public.usage_tracking (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  run_id            uuid references public.agent_runs(id) on delete set null,
  provider          ai_provider not null,
  model             text not null,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  kind              text not null default 'completion', -- completion | embedding | execution
  occurred_at       timestamptz not null default now()
);

create table public.billing_records (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  period_start      date not null,
  period_end        date not null,
  plan              plan_tier not null,
  base_amount_usd   numeric(12,2) not null default 0,
  usage_amount_usd  numeric(12,2) not null default 0,
  total_amount_usd  numeric(12,2) not null default 0,
  status            billing_status not null default 'pending',
  stripe_invoice_id text,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, period_start, period_end)
);

-- ----------------------------------------------------------------------------
-- audit_logs & rate limiting
-- ----------------------------------------------------------------------------
create table public.audit_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.users(id) on delete set null,
  action            audit_action not null,
  resource_type     text,
  resource_id       uuid,
  metadata          jsonb not null default '{}',
  ip_address        inet,
  user_agent        text,
  created_at        timestamptz not null default now()
);

create table public.rate_limits (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  bucket            text not null,              -- 'agent_run' | 'github_sync' | 'chat' | ...
  window_start      timestamptz not null,
  request_count     integer not null default 0,
  unique (user_id, bucket, window_start)
);

-- ============================================================================
-- Indexes
-- ============================================================================
create index idx_repositories_user            on public.repositories(user_id);
create index idx_repo_branches_repo           on public.repository_branches(repository_id);
create index idx_repo_files_repo_branch       on public.repository_files(repository_id, branch);
create index idx_repo_files_path_trgm         on public.repository_files using gin (path gin_trgm_ops);
create index idx_repo_files_embedding         on public.repository_files
  using hnsw (embedding vector_cosine_ops);

create index idx_provider_configs_user        on public.provider_configs(user_id);
create index idx_agents_user                  on public.agents(user_id) where not is_archived;
create index idx_agents_repo                  on public.agents(repository_id);

create index idx_tasks_user_status            on public.agent_tasks(user_id, status);
create index idx_tasks_agent                  on public.agent_tasks(agent_id, created_at desc);
create index idx_runs_task                    on public.agent_runs(task_id);
create index idx_runs_user_created            on public.agent_runs(user_id, created_at desc);

create index idx_messages_agent_created       on public.agent_messages(agent_id, created_at);
create index idx_messages_task                on public.agent_messages(task_id);

create index idx_memories_user_scope          on public.agent_memories(user_id, scope);
create index idx_memories_repo                on public.agent_memories(repository_id) where repository_id is not null;
create index idx_memories_pinned              on public.agent_memories(user_id) where pinned;
create index idx_memories_embedding           on public.agent_memories
  using hnsw (embedding vector_cosine_ops);
create index idx_memories_content_trgm        on public.agent_memories using gin (content gin_trgm_ops);

create index idx_commits_repo                 on public.commits(repository_id, created_at desc);
create index idx_prs_user_status              on public.pull_requests(user_id, status);
create index idx_prs_repo                     on public.pull_requests(repository_id, created_at desc);

create index idx_exec_logs_run                on public.execution_logs(run_id);
create index idx_exec_logs_user_created       on public.execution_logs(user_id, created_at desc);

create index idx_usage_user_time              on public.usage_tracking(user_id, occurred_at desc);
create index idx_usage_provider_time          on public.usage_tracking(provider, occurred_at desc);
create index idx_billing_user                 on public.billing_records(user_id, period_start desc);
create index idx_audit_user_time              on public.audit_logs(user_id, created_at desc);
create index idx_audit_action_time            on public.audit_logs(action, created_at desc);

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users','repositories','provider_configs','agents',
    'agent_tasks','agent_memories','pull_requests']
  loop
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
