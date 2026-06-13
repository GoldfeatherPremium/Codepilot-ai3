-- ============================================================================
-- CodePilot AI — Migration 00002: Row Level Security
-- Principle: users see only their rows; admins see everything; encrypted
-- secrets are never selectable by clients (service-role only views).
-- ============================================================================

-- Helper: is the current user an admin?
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'admin'
  );
$$;

-- Enable RLS everywhere
do $$
declare t text;
begin
  foreach t in array array[
    'users','repositories','repository_branches','repository_files',
    'provider_configs','agents','agent_tasks','agent_runs','agent_messages',
    'agent_memories','commits','pull_requests','execution_logs',
    'usage_tracking','billing_records','audit_logs','rate_limits'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
create policy users_select_self  on public.users for select
  using (id = auth.uid() or public.is_admin());
create policy users_update_self  on public.users for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- users cannot self-escalate role or plan
    and role = (select role from public.users u where u.id = auth.uid())
    and plan = (select plan from public.users u where u.id = auth.uid())
  );
create policy users_admin_update on public.users for update
  using (public.is_admin()) with check (public.is_admin());

-- GitHub token columns are protected at the column level:
revoke select (github_token_ciphertext, github_token_iv) on public.users
  from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Generic owner policies
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'repositories','provider_configs','agents','agent_tasks','agent_runs',
    'agent_messages','agent_memories','pull_requests','execution_logs',
    'usage_tracking','billing_records'
  ] loop
    execute format($f$
      create policy %1$s_select on public.%1$s for select
        using (user_id = auth.uid() or public.is_admin());
    $f$, t);
  end loop;
end $$;

-- Inserts/updates/deletes for user-managed tables
do $$
declare t text;
begin
  foreach t in array array['repositories','provider_configs','agents','agent_tasks','agent_memories']
  loop
    execute format($f$
      create policy %1$s_insert on public.%1$s for insert
        with check (user_id = auth.uid());
      create policy %1$s_update on public.%1$s for update
        using (user_id = auth.uid()) with check (user_id = auth.uid());
      create policy %1$s_delete on public.%1$s for delete
        using (user_id = auth.uid());
    $f$, t);
  end loop;
end $$;

-- Chat: users may insert their own messages (assistant rows are written by
-- the service role inside edge functions and bypass RLS).
create policy agent_messages_insert on public.agent_messages for insert
  with check (user_id = auth.uid() and role = 'user');

-- provider_configs: encrypted key columns never reach the client
revoke select (key_ciphertext, key_iv) on public.provider_configs
  from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Child tables scoped through the parent repository
-- ----------------------------------------------------------------------------
create policy repo_branches_select on public.repository_branches for select
  using (exists (
    select 1 from public.repositories r
    where r.id = repository_id and (r.user_id = auth.uid() or public.is_admin())
  ));

create policy repo_files_select on public.repository_files for select
  using (exists (
    select 1 from public.repositories r
    where r.id = repository_id and (r.user_id = auth.uid() or public.is_admin())
  ));

create policy commits_select on public.commits for select
  using (exists (
    select 1 from public.repositories r
    where r.id = repository_id and (r.user_id = auth.uid() or public.is_admin())
  ));

-- ----------------------------------------------------------------------------
-- audit_logs: users read their own; only service role writes
-- ----------------------------------------------------------------------------
create policy audit_select on public.audit_logs for select
  using (user_id = auth.uid() or public.is_admin());

-- rate_limits: service-role only (no client policies at all)

-- ----------------------------------------------------------------------------
-- Realtime: stream chat + run timelines to owners
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table public.agent_messages;
alter publication supabase_realtime add table public.agent_runs;
alter publication supabase_realtime add table public.agent_tasks;
alter publication supabase_realtime add table public.execution_logs;
