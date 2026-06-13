-- ============================================================================
-- CodePilot AI — Migration 00003: Functions, RPC, triggers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- New auth user → profile row
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, avatar_url, github_username, github_user_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    new.raw_user_meta_data->>'user_name',
    nullif(new.raw_user_meta_data->>'provider_id','')::bigint
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Semantic memory search (pgvector cosine + pin/recency boosts)
-- ----------------------------------------------------------------------------
create or replace function public.match_memories(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_scope memory_scope default null,
  p_repository_id uuid default null,
  p_match_count int default 8,
  p_min_similarity float default 0.70
) returns table (
  id uuid, scope memory_scope, category memory_category,
  title text, content text, pinned boolean,
  similarity float, score float
)
language sql stable security definer set search_path = public as $$
  select
    m.id, m.scope, m.category, m.title, m.content, m.pinned,
    1 - (m.embedding <=> p_query_embedding) as similarity,
    (1 - (m.embedding <=> p_query_embedding))
      * m.relevance_score
      * (case when m.pinned then 1.25 else 1.0 end)
      * (1.0 / (1.0 + extract(epoch from now() - m.created_at) / 86400.0 / 90.0)) as score
  from public.agent_memories m
  where m.user_id = p_user_id
    and m.embedding is not null
    and (p_scope is null or m.scope = p_scope)
    and (p_repository_id is null or m.repository_id = p_repository_id or m.scope = 'user')
    and 1 - (m.embedding <=> p_query_embedding) >= p_min_similarity
  order by score desc
  limit p_match_count;
$$;

-- Record a memory recall (boost relevance, track access)
create or replace function public.touch_memory(p_memory_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.agent_memories
  set last_accessed_at = now(),
      access_count = access_count + 1,
      relevance_score = least(relevance_score * 1.05, 2.0)
  where id = p_memory_id;
$$;

-- ----------------------------------------------------------------------------
-- Hybrid codebase search: semantic + path trigram
-- ----------------------------------------------------------------------------
create or replace function public.search_repository_files(
  p_repository_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_match_count int default 12
) returns table (path text, language text, summary text, score float)
language sql stable security definer set search_path = public as $$
  with semantic as (
    select f.path, f.language, f.summary,
           case when p_query_embedding is null then 0
                else 1 - (f.embedding <=> p_query_embedding) end as sem
    from public.repository_files f
    where f.repository_id = p_repository_id and not f.is_binary
  )
  select s.path, s.language, s.summary,
         (0.65 * s.sem + 0.35 * similarity(s.path, p_query)) as score
  from semantic s
  order by score desc
  limit p_match_count;
$$;

-- ----------------------------------------------------------------------------
-- Sliding-window rate limiting (called from edge functions, service role)
-- ----------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_limit int,
  p_window_seconds int default 3600
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := date_trunc('hour', now())
    + floor(extract(minute from now())::int / (p_window_seconds / 60.0))
      * make_interval(secs => p_window_seconds);
  v_count int;
begin
  insert into public.rate_limits (user_id, bucket, window_start, request_count)
  values (p_user_id, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start)
  do update set request_count = public.rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= p_limit;
end $$;

-- ----------------------------------------------------------------------------
-- Usage accounting
-- ----------------------------------------------------------------------------
create or replace function public.record_usage(
  p_user_id uuid, p_run_id uuid, p_provider ai_provider, p_model text,
  p_input bigint, p_output bigint, p_cost numeric, p_kind text default 'completion'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.usage_tracking
    (user_id, run_id, provider, model, input_tokens, output_tokens, cost_usd, kind)
  values (p_user_id, p_run_id, p_provider, p_model, p_input, p_output, p_cost, p_kind);

  if p_run_id is not null then
    update public.agent_runs
    set input_tokens = input_tokens + p_input,
        output_tokens = output_tokens + p_output,
        cost_usd = cost_usd + p_cost
    where id = p_run_id;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Dashboard metrics in a single round trip
-- ----------------------------------------------------------------------------
create or replace function public.dashboard_metrics(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'repositories',  (select count(*) from repositories  where user_id = p_user_id),
    'active_agents', (select count(*) from agents        where user_id = p_user_id and not is_archived),
    'pull_requests', (select count(*) from pull_requests where user_id = p_user_id),
    'open_prs',      (select count(*) from pull_requests where user_id = p_user_id and status = 'open'),
    'tasks_completed', (select count(*) from agent_tasks where user_id = p_user_id and status = 'completed'),
    'tasks_running',   (select count(*) from agent_tasks where user_id = p_user_id and status = 'running'),
    'tokens_month', (select coalesce(sum(input_tokens + output_tokens), 0)
                     from usage_tracking
                     where user_id = p_user_id
                       and occurred_at >= date_trunc('month', now())),
    'cost_month',   (select coalesce(sum(cost_usd), 0)::numeric(12,2)
                     from usage_tracking
                     where user_id = p_user_id
                       and occurred_at >= date_trunc('month', now())),
    'usage_series', (select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
                     from (
                       select date_trunc('day', occurred_at)::date as day,
                              sum(input_tokens + output_tokens) as tokens,
                              sum(cost_usd)::numeric(12,4) as cost
                       from usage_tracking
                       where user_id = p_user_id and occurred_at >= now() - interval '30 days'
                       group by 1
                     ) d)
  );
$$;

-- Admin: platform-wide metrics
create or replace function public.admin_metrics()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then jsonb_build_object(
    'total_users',   (select count(*) from users),
    'total_repos',   (select count(*) from repositories),
    'runs_today',    (select count(*) from agent_runs where created_at >= current_date),
    'runs_failed_today', (select count(*) from agent_runs where created_at >= current_date and status = 'failed'),
    'queued_runs',   (select count(*) from agent_runs where status = 'queued'),
    'running_runs',  (select count(*) from agent_runs where status = 'running'),
    'tokens_today',  (select coalesce(sum(input_tokens + output_tokens),0) from usage_tracking where occurred_at >= current_date),
    'revenue_month', (select coalesce(sum(total_amount_usd),0) from billing_records where period_start >= date_trunc('month', now()))
  ) else null end;
$$;

-- ----------------------------------------------------------------------------
-- Audit helper
-- ----------------------------------------------------------------------------
create or replace function public.write_audit(
  p_user_id uuid, p_action audit_action, p_resource_type text,
  p_resource_id uuid, p_metadata jsonb default '{}'
) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_logs (user_id, action, resource_type, resource_id, metadata)
  values (p_user_id, p_action, p_resource_type, p_resource_id, p_metadata);
$$;
