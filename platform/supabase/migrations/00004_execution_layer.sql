-- ============================================================================
-- 00004_execution_layer.sql
-- Code intelligence (symbol index, dependency graph, cross-file references)
-- and the autonomous repair loop (every build/test failure, the model's
-- analysis, and the fix are stored as first-class rows).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- agents: repair-loop budget
-- ----------------------------------------------------------------------------
alter table public.agents
  add column if not exists max_repair_attempts integer not null default 3
    check (max_repair_attempts between 0 and 10);

-- ----------------------------------------------------------------------------
-- code_symbols — function map, class map, and everything in between.
-- Populated by github-sync during indexing; queried by the search_symbols tool.
-- ----------------------------------------------------------------------------
create type symbol_kind as enum (
  'function','method','class','interface','type','enum','const','var',
  'struct','trait','impl','module','component','export'
);

create table public.code_symbols (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  file_path         text not null,
  name              text not null,
  kind              symbol_kind not null,
  line              integer not null default 0,
  signature         text,                      -- first line of the definition
  exported          boolean not null default false,
  created_at        timestamptz not null default now()
);

create index idx_symbols_repo_name_trgm on public.code_symbols using gin (name gin_trgm_ops);
create index idx_symbols_repo            on public.code_symbols(repository_id, kind);
create index idx_symbols_repo_file       on public.code_symbols(repository_id, file_path);

-- ----------------------------------------------------------------------------
-- file_dependencies — the import graph. from_path imports to_path (resolved
-- for relative imports; raw specifier kept for package imports).
-- ----------------------------------------------------------------------------
create table public.file_dependencies (
  id                uuid primary key default gen_random_uuid(),
  repository_id     uuid not null references public.repositories(id) on delete cascade,
  from_path         text not null,
  to_path           text,                       -- null for external packages
  import_spec       text not null,              -- as written in source
  imported_names    text[] not null default '{}',
  is_external       boolean not null default false,
  created_at        timestamptz not null default now()
);

create index idx_deps_repo_from on public.file_dependencies(repository_id, from_path);
create index idx_deps_repo_to   on public.file_dependencies(repository_id, to_path);
create index idx_deps_names     on public.file_dependencies using gin (imported_names);

-- ----------------------------------------------------------------------------
-- repair_attempts — the autonomous Plan→Edit→Build→Test→Analyze→Fix→Retry loop.
-- One row per failed verification; analysis + fix recorded when the model
-- responds; status flips to 'fixed' when a later verification passes.
-- ----------------------------------------------------------------------------
create type repair_status as enum ('failed','analyzing','fixed','exhausted');

create table public.repair_attempts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  run_id            uuid not null references public.agent_runs(id) on delete cascade,
  task_id           uuid references public.agent_tasks(id) on delete cascade,
  attempt_no        integer not null,
  trigger           text not null check (trigger in ('build','test','command')),
  command           text not null,
  exit_code         integer,
  output_excerpt    text not null default '',
  analysis          text,                       -- model's root-cause reasoning
  fix_summary       text,                       -- what the model changed and why
  files_touched     jsonb not null default '[]',
  snapshot_before   text,                       -- workspace snapshot sha taken before the failing run
  status            repair_status not null default 'failed',
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  unique (run_id, attempt_no)
);

create index idx_repair_run on public.repair_attempts(run_id, attempt_no);

-- ----------------------------------------------------------------------------
-- RLS — same ownership model as everything else.
-- ----------------------------------------------------------------------------
alter table public.code_symbols      enable row level security;
alter table public.code_symbols      force row level security;
alter table public.file_dependencies enable row level security;
alter table public.file_dependencies force row level security;
alter table public.repair_attempts   enable row level security;
alter table public.repair_attempts   force row level security;

create policy symbols_select on public.code_symbols for select
  using (exists (select 1 from public.repositories r
                 where r.id = repository_id and r.user_id = auth.uid()));

create policy deps_select on public.file_dependencies for select
  using (exists (select 1 from public.repositories r
                 where r.id = repository_id and r.user_id = auth.uid()));

create policy repair_select on public.repair_attempts for select
  using (user_id = auth.uid());

-- Writes happen only via service role (edge functions); no client policies.

-- Live repair-loop progress in the UI.
alter publication supabase_realtime add table public.repair_attempts;

-- ----------------------------------------------------------------------------
-- search_symbols — trigram-ranked symbol lookup with exact-prefix boost.
-- ----------------------------------------------------------------------------
create or replace function public.search_symbols(
  p_repository_id uuid,
  p_query text,
  p_kind symbol_kind default null,
  p_match_count int default 20
)
returns table (
  file_path text, name text, kind symbol_kind, line int,
  signature text, exported boolean, score real
)
language sql stable security definer set search_path = public as $$
  select s.file_path, s.name, s.kind, s.line, s.signature, s.exported,
         (similarity(s.name, p_query)
          + case when s.name ilike p_query || '%' then 0.5 else 0 end
          + case when s.name = p_query then 1.0 else 0 end
          + case when s.exported then 0.1 else 0 end)::real as score
  from code_symbols s
  where s.repository_id = p_repository_id
    and (p_kind is null or s.kind = p_kind)
    and (s.name % p_query or s.name ilike '%' || p_query || '%')
  order by score desc, s.file_path
  limit p_match_count;
$$;

-- ----------------------------------------------------------------------------
-- find_references — cross-file references via the import graph: which files
-- import the symbol (by name) or import the file that defines it.
-- ----------------------------------------------------------------------------
create or replace function public.find_references(
  p_repository_id uuid,
  p_symbol text,
  p_match_count int default 30
)
returns table (from_path text, import_spec text, via text)
language sql stable security definer set search_path = public as $$
  -- direct: files importing the symbol by name
  select d.from_path, d.import_spec, 'named-import'::text as via
  from file_dependencies d
  where d.repository_id = p_repository_id
    and d.imported_names @> array[p_symbol]
  union
  -- indirect: files importing any file that defines the symbol
  select d.from_path, d.import_spec, 'file-import'::text as via
  from file_dependencies d
  join code_symbols s
    on s.repository_id = d.repository_id and s.file_path = d.to_path
  where d.repository_id = p_repository_id
    and s.name = p_symbol
  limit p_match_count;
$$;

-- ----------------------------------------------------------------------------
-- file_dependency_graph — inbound + outbound edges for one file (the agent's
-- "what breaks if I change this?" query).
-- ----------------------------------------------------------------------------
create or replace function public.file_dependency_graph(
  p_repository_id uuid,
  p_path text
)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'imports', coalesce((
      select jsonb_agg(jsonb_build_object('to', coalesce(d.to_path, d.import_spec),
                                          'names', d.imported_names,
                                          'external', d.is_external))
      from file_dependencies d
      where d.repository_id = p_repository_id and d.from_path = p_path
    ), '[]'::jsonb),
    'imported_by', coalesce((
      select jsonb_agg(jsonb_build_object('from', d.from_path, 'names', d.imported_names))
      from file_dependencies d
      where d.repository_id = p_repository_id and d.to_path = p_path
    ), '[]'::jsonb),
    'symbols', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind, 'line', s.line))
      from code_symbols s
      where s.repository_id = p_repository_id and s.file_path = p_path
    ), '[]'::jsonb)
  );
$$;

-- ----------------------------------------------------------------------------
-- repository_intel_summary — function/class maps for the repo overview.
-- ----------------------------------------------------------------------------
create or replace function public.repository_intel_summary(p_repository_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'symbol_count',  (select count(*) from code_symbols where repository_id = p_repository_id),
    'by_kind', coalesce((
      select jsonb_object_agg(kind, n) from (
        select kind, count(*) as n from code_symbols
        where repository_id = p_repository_id group by kind
      ) k
    ), '{}'::jsonb),
    'edge_count',    (select count(*) from file_dependencies
                      where repository_id = p_repository_id and not is_external),
    'external_packages', coalesce((
      select jsonb_agg(distinct import_spec) from (
        select import_spec from file_dependencies
        where repository_id = p_repository_id and is_external
        limit 100
      ) e
    ), '[]'::jsonb)
  );
$$;
