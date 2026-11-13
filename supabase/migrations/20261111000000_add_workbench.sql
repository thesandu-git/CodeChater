-- AI 工作台（Workbench）——严格增量迁移。
-- 只新建 wb_* 对象，绝不修改 public.tasks / public.messages 及任何既有策略。
-- 线上 Agent Bridge 仍在运行：本文件可重复执行，不 drop、不 truncate、不 alter 既有表。

create extension if not exists pgcrypto;

-- ── 参与方 ────────────────────────────────────────────────────────────────
create table if not exists public.wb_agents (
  id           text primary key check (id ~ '^[a-z0-9_-]{2,32}$'),
  display_name text not null,
  kind         text not null default 'bot' check (kind in ('bot', 'human')),
  platform     text,
  role         text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

insert into public.wb_agents (id, display_name, kind, platform, role) values
  ('grokbot', 'Grokbot', 'bot', 'xAI',      '提出任务 / 汇报'),
  ('codex',   'Codex',   'bot', 'Codex CLI','执行'),
  ('dev2',    'Dev 2',   'bot', 'Hermes',   '执行 / 汇报'),
  ('hermes',  'Hermes',  'bot', 'Nous Research', '执行 / 汇报'),
  ('openbot', 'OpenBot', 'bot', 'OpenBot',  '执行 / 汇报')
on conflict (id) do nothing;

-- ── 产品预案 ──────────────────────────────────────────────────────────────
create table if not exists public.wb_product_plans (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (char_length(title) between 1 and 180),
  summary         text not null default '' check (char_length(summary) <= 6000),
  status          text not null default 'draft'
                  check (status in ('draft', 'validated', 'approved', 'rejected', 'converted', 'archived')),
  source_agent    text references public.wb_agents(id),
  proposed_by     text,
  target_user     text,
  price_hypothesis numeric(12,2) check (price_hypothesis is null or price_hypothesis >= 0),
  currency        text not null default 'LKR',
  proposed_at     timestamptz not null default now(),
  decided_at      timestamptz,
  project_id      uuid,
  notes           text not null default '' check (char_length(notes) <= 6000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists wb_plans_status_idx on public.wb_product_plans (status, proposed_at desc);

-- ── 项目 ──────────────────────────────────────────────────────────────────
create table if not exists public.wb_projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 180),
  slug             text,
  plan_id          uuid references public.wb_product_plans(id) on delete set null,
  stage            text not null default 'idea'
                   check (stage in ('idea', 'proposal', 'validated', 'build', 'testing', 'launch', 'revenue')),
  status           text not null default 'active'
                   check (status in ('active', 'blocked', 'paused', 'done', 'killed')),
  owner_agent      text references public.wb_agents(id),
  repo_url         text,
  preview_url      text,
  monetization_model text,
  currency         text not null default 'LKR',
  monthly_revenue  numeric(12,2) not null default 0 check (monthly_revenue >= 0),
  blocked_reason   text,
  blocker_owner    text,
  started_at       timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  last_progress_at timestamptz not null default now(),
  monetized_at     timestamptz,
  target_launch_at date,
  summary          text not null default '' check (char_length(summary) <= 6000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists wb_projects_name_uniq on public.wb_projects (lower(name));
create index if not exists wb_projects_stage_idx on public.wb_projects (status, stage);

-- 预案 ↔ 项目 的反向指针（幂等添加）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wb_plans_project_fk'
  ) then
    alter table public.wb_product_plans
      add constraint wb_plans_project_fk
      foreign key (project_id) references public.wb_projects(id) on delete set null;
  end if;
end $$;

-- ── 阶段迁移历史（用于估算"还要多久"）────────────────────────────────────
create table if not exists public.wb_stage_events (
  id         bigserial primary key,
  project_id uuid not null references public.wb_projects(id) on delete cascade,
  from_stage text,
  to_stage   text not null,
  actor_agent text references public.wb_agents(id),
  note       text,
  day        date not null default ((now() at time zone 'Asia/Colombo')::date),
  created_at timestamptz not null default now()
);

create index if not exists wb_stage_events_project_idx
  on public.wb_stage_events (project_id, created_at);

-- ── bot 进度汇报 ──────────────────────────────────────────────────────────
create table if not exists public.wb_reports (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.wb_projects(id) on delete cascade,
  agent         text not null references public.wb_agents(id),
  kind          text not null default 'progress'
                check (kind in ('progress', 'blocker', 'decision', 'milestone', 'note')),
  summary       text not null check (char_length(summary) between 1 and 500),
  detail        text not null default '' check (char_length(detail) <= 8000),
  percent       smallint check (percent between 0 and 100),
  outcome       text not null default 'unchanged'
                check (outcome in ('advanced', 'unchanged', 'failed')),
  blocked       boolean not null default false,
  blocker_owner text,
  tokens_total  bigint not null default 0 check (tokens_total >= 0),
  task_id       uuid references public.tasks(id) on delete set null,
  source        text not null default 'api' check (char_length(source) <= 40),
  day           date not null default ((now() at time zone 'Asia/Colombo')::date),
  created_at    timestamptz not null default now()
);

create index if not exists wb_reports_project_idx on public.wb_reports (project_id, created_at desc);
create index if not exists wb_reports_day_idx on public.wb_reports (day, agent);

-- ── token 消耗（按 agent × 天 × 项目 记账）────────────────────────────────
create table if not exists public.wb_token_usage (
  id           bigserial primary key,
  agent        text not null references public.wb_agents(id),
  project_id   uuid references public.wb_projects(id) on delete cascade,
  day          date not null default ((now() at time zone 'Asia/Colombo')::date),
  tokens_in    bigint not null default 0 check (tokens_in >= 0),
  tokens_out   bigint not null default 0 check (tokens_out >= 0),
  project_key  uuid generated always as (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  waste_tokens bigint not null default 0 check (waste_tokens >= 0),
  waste_reason text,
  model        text,
  sessions     integer check (sessions is null or sessions >= 0),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 已存在旧表时补齐 project_key（幂等）
alter table public.wb_token_usage
  add column if not exists project_key uuid
  generated always as (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored;

drop index if exists public.wb_token_usage_key;
create unique index if not exists wb_token_usage_key
  on public.wb_token_usage (agent, day, project_key);

-- ── 每日 Agent log ────────────────────────────────────────────────────────
create table if not exists public.wb_agent_logs (
  id            uuid primary key default gen_random_uuid(),
  agent         text not null references public.wb_agents(id),
  day           date not null default ((now() at time zone 'Asia/Colombo')::date),
  log_markdown  text not null check (char_length(log_markdown) between 1 and 20000),
  projects      jsonb not null default '[]'::jsonb,
  tokens_total  bigint not null default 0,
  waste_tokens  bigint not null default 0,
  tasks_done    integer,
  tasks_failed  integer,
  self_review   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (agent, day)
);

-- ── 小工具：阶段顺序 ──────────────────────────────────────────────────────
create or replace function public.wb_stage_index(p_stage text)
returns integer language sql immutable as
$$ select array_position(array['idea','proposal','validated','build','testing','launch','revenue'], p_stage) $$;

-- ── 视图：项目看板 ────────────────────────────────────────────────────────
create or replace view public.wb_project_board as
select
  p.id, p.name, p.slug, p.stage, p.status, p.owner_agent,
  p.repo_url, p.preview_url, p.monetization_model, p.currency, p.monthly_revenue,
  p.blocked_reason, p.blocker_owner, p.summary, p.plan_id,
  p.started_at, p.stage_entered_at, p.last_progress_at, p.monetized_at, p.target_launch_at,
  floor(extract(epoch from (now() - p.stage_entered_at)) / 86400)::int as days_in_stage,
  floor(extract(epoch from (now() - p.last_progress_at)) / 86400)::int as days_since_progress,
  floor(extract(epoch from (now() - p.started_at)) / 86400)::int as days_since_start,
  case when p.monetized_at is null then null
       else floor(extract(epoch from (p.monetized_at - p.started_at)) / 86400)::int end as days_to_revenue,
  (p.status = 'blocked' or p.status = 'paused'
   or (p.status = 'active' and now() - p.last_progress_at > interval '3 days')) as is_stuck,
  pl.title as plan_title,
  r.agent  as last_agent,
  r.summary as last_report,
  r.created_at as last_report_at
from public.wb_projects p
left join public.wb_product_plans pl on pl.id = p.plan_id
left join lateral (
  select agent, summary, created_at
  from public.wb_reports
  where project_id = p.id
  order by created_at desc
  limit 1
) r on true;

-- ── 视图：每个阶段的实际耗时（中位数）────────────────────────────────────
create or replace view public.wb_stage_median as
select
  s.to_stage as stage,
  count(*)::int as samples,
  round((percentile_cont(0.5) within group (
    order by extract(epoch from (s.next_at - s.created_at)) / 86400
  ))::numeric, 1) as median_days
from (
  select e.*, lead(e.created_at) over (partition by e.project_id order by e.created_at) as next_at
  from public.wb_stage_events e
) s
where s.next_at is not null
group by s.to_stage;

-- ── 视图：agent × 天 汇总 ─────────────────────────────────────────────────
create or replace view public.wb_agent_daily as
with days as (
  select day from public.wb_token_usage
  union
  select day from public.wb_reports
),
tok as (
  select agent, day,
         sum(tokens_in)::bigint  as tokens_in,
         sum(tokens_out)::bigint as tokens_out,
         sum(waste_tokens)::bigint as waste_tokens,
         count(distinct project_id)::int as projects_touched
  from public.wb_token_usage group by agent, day
),
rep as (
  select agent, day,
         count(*)::int as reports,
         count(*) filter (where outcome = 'advanced')::int as advances,
         count(*) filter (where outcome = 'failed')::int as failures,
         count(*) filter (where blocked or kind = 'blocker')::int as blockers,
         count(distinct project_id)::int as report_projects
  from public.wb_reports group by agent, day
)
select d.day, a.id as agent, a.display_name,
       coalesce(tok.tokens_in, 0)     as tokens_in,
       coalesce(tok.tokens_out, 0)    as tokens_out,
       coalesce(tok.tokens_in, 0) + coalesce(tok.tokens_out, 0) as tokens_total,
       coalesce(tok.waste_tokens, 0)  as waste_tokens,
       coalesce(rep.reports, 0)       as reports,
       coalesce(rep.advances, 0)      as advances,
       coalesce(rep.failures, 0)      as failures,
       coalesce(rep.blockers, 0)      as blockers,
       greatest(coalesce(tok.projects_touched, 0), coalesce(rep.report_projects, 0)) as projects_touched
from days d
cross join public.wb_agents a
left join tok on tok.agent = a.id and tok.day = d.day
left join rep on rep.agent = a.id and rep.day = d.day
where a.active and (coalesce(tok.tokens_in, 0) + coalesce(tok.tokens_out, 0) > 0
                    or coalesce(rep.reports, 0) > 0);

-- ── 主函数：仪表盘一次性取数 ──────────────────────────────────────────────
create or replace function public.wb_overview(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Colombo')::date);
  v jsonb;
begin
  with day_tok as (
    select coalesce(sum(tokens_in + tokens_out), 0)::bigint as total,
           coalesce(sum(waste_tokens), 0)::bigint as waste
    from public.wb_token_usage where day = v_day
  ),
  day_rep as (
    select count(*)::int as reports,
           count(distinct project_id) filter (where project_id is not null)::int as projects_touched,
           count(distinct project_id) filter (where outcome = 'advanced')::int as advances
    from public.wb_reports where day = v_day
  ),
  board as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'stage', b.stage, 'status', b.status,
      'owner', b.owner_agent, 'daysInStage', b.days_in_stage,
      'summary', b.summary,
      'daysSinceProgress', b.days_since_progress, 'isStuck', b.is_stuck,
      'planTitle', b.plan_title, 'blockedReason', b.blocked_reason,
      'blockerOwner', b.blocker_owner, 'lastAgent', b.last_agent,
      'lastReport', b.last_report, 'lastReportAt', b.last_report_at,
      'repoUrl', b.repo_url, 'previewUrl', b.preview_url,
      'monetizationModel', b.monetization_model, 'monthlyRevenue', b.monthly_revenue,
      'currency', b.currency, 'daysToRevenue', b.days_to_revenue,
      'startedAt', b.started_at, 'targetLaunchAt', b.target_launch_at,
      'etaDays', case when b.stage = 'revenue' then 0 when exists (
          select 1 from public.wb_stage_median m
          where public.wb_stage_index(m.stage) > public.wb_stage_index(b.stage) and m.samples < 2
        ) then null else (
        select nullif(round(sum(m.median_days)), 0)::int
        from public.wb_stage_median m
        where public.wb_stage_index(m.stage) > public.wb_stage_index(b.stage)
      ) end,
      'etaSamples', (select coalesce(sum(m.samples), 0)::int from public.wb_stage_median m
                     where public.wb_stage_index(m.stage) > public.wb_stage_index(b.stage)),
      'etaComplete', case when b.stage = 'revenue' then true else
        (select count(*) from public.wb_stage_median m
          where public.wb_stage_index(m.stage) > public.wb_stage_index(b.stage) and m.samples >= 2)
        = (7 - public.wb_stage_index(b.stage)) end
    ) order by public.wb_stage_index(b.stage), b.days_since_progress desc), '[]'::jsonb) as items
    from public.wb_project_board b
  ),
  funnel as (
    select coalesce(jsonb_object_agg(s.stage, coalesce(c.n, 0) order by s.ord), '{}'::jsonb) as items
    from (values ('idea',1),('proposal',2),('validated',3),('build',4),('testing',5),('launch',6),('revenue',7)) as s(stage, ord)
    left join (
      select stage, count(*)::int as n from public.wb_projects
      where status <> 'killed' group by stage
    ) c on c.stage = s.stage
  ),
  plans as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'status', status, 'summary', summary,
      'sourceAgent', source_agent, 'proposedAt', proposed_at,
      'decidedAt', decided_at, 'projectId', project_id,
      'targetUser', target_user, 'priceHypothesis', price_hypothesis, 'currency', currency
    ) order by proposed_at desc), '[]'::jsonb) as items
    from public.wb_product_plans
    where status <> 'archived'
  ),
  plan_counts as (
    select count(*)::int as total,
           count(*) filter (where status in ('draft','validated','approved'))::int as open,
           count(*) filter (where status = 'converted')::int as converted
    from public.wb_product_plans where status <> 'archived'
  ),
  proj_counts as (
    select count(*)::int as total,
           count(*) filter (where status = 'active')::int as active,
           count(*) filter (where status = 'blocked')::int as blocked,
           count(*) filter (where status = 'paused')::int as paused,
           count(*) filter (where stage = 'revenue' or monetized_at is not null)::int as monetized
    from public.wb_projects where status <> 'killed'
  ),
  stuck as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'stage', stage, 'status', status,
      'daysSinceProgress', days_since_progress, 'daysInStage', days_in_stage,
      'blockedReason', blocked_reason, 'blockerOwner', blocker_owner,
      'lastAgent', last_agent, 'lastReport', last_report, 'lastReportAt', last_report_at
    ) order by days_since_progress desc), '[]'::jsonb) as items
    from public.wb_project_board where is_stuck
  ),
  feed as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'agent', r.agent, 'project', p.name, 'projectId', r.project_id,
      'kind', r.kind, 'outcome', r.outcome, 'summary', r.summary, 'detail', r.detail,
      'blocked', r.blocked, 'blockerOwner', r.blocker_owner, 'createdAt', r.created_at
    ) order by r.created_at desc), '[]'::jsonb) as items
    from (select * from public.wb_reports where day = v_day order by created_at desc limit 50) r
    left join public.wb_projects p on p.id = r.project_id
  ),
  agent_day as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'agent', agent, 'name', display_name, 'tokensIn', tokens_in, 'tokensOut', tokens_out,
      'tokensTotal', tokens_total, 'wasteTokens', waste_tokens, 'wasteRate',
        case when tokens_total > 0 then round(waste_tokens::numeric / tokens_total, 3) else 0 end,
      'reports', reports, 'advances', advances, 'failures', failures, 'blockers', blockers,
      'projectsTouched', projects_touched
    ) order by tokens_total desc), '[]'::jsonb) as items
    from public.wb_agent_daily where day = v_day
  ),
  participation as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'projectId', t.project_id, 'project', p.name, 'agent', t.agent,
      'tokens', t.tokens, 'reports', t.reports, 'lastAt', t.last_at
    )), '[]'::jsonb) as items
    from (
      select project_id, agent, sum(tokens_total)::bigint as tokens,
             sum(reports)::int as reports, max(last_at) as last_at
      from (
        select project_id, agent, tokens_in + tokens_out as tokens_total, 0 as reports, created_at as last_at
        from public.wb_token_usage where day between v_day - 6 and v_day and project_id is not null
        union all
        select project_id, agent, 0, 1, created_at
        from public.wb_reports where day between v_day - 6 and v_day and project_id is not null
      ) x group by project_id, agent
    ) t
    left join public.wb_projects p on p.id = t.project_id
  ),
  logs as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'agent', l.agent, 'day', l.day, 'markdown', l.log_markdown,
      'tokensTotal', l.tokens_total, 'wasteTokens', l.waste_tokens,
      'tasksDone', l.tasks_done, 'tasksFailed', l.tasks_failed,
      'selfReview', l.self_review, 'projects', l.projects, 'createdAt', l.created_at
    )), '[]'::jsonb) as items
    from public.wb_agent_logs l where l.day = v_day
  ),
  medians as (
    select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'medianDays', median_days, 'samples', samples) order by public.wb_stage_index(stage)), '[]'::jsonb) as items
    from public.wb_stage_median
  ),
  last_7 as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'day', day, 'tokens', tokens, 'waste', waste, 'advances', advances, 'reports', reports
    ) order by day), '[]'::jsonb) as items
    from (
      select d.day::date as day,
             coalesce((select sum(tokens_in + tokens_out) from public.wb_token_usage t where t.day = d.day), 0)::bigint as tokens,
             coalesce((select sum(waste_tokens) from public.wb_token_usage t where t.day = d.day), 0)::bigint as waste,
             coalesce((select count(*) from public.wb_reports r where r.day = d.day and r.outcome = 'advanced'), 0)::int as advances,
             coalesce((select count(*) from public.wb_reports r where r.day = d.day), 0)::int as reports
      from (select generate_series(v_day - 6, v_day, interval '1 day')::date as day) d
    ) s
  ),
  unaudited as (
    select coalesce(jsonb_agg(jsonb_build_object('agent', agent, 'name', display_name, 'tokensTotal', tokens_total)), '[]'::jsonb) as items
    from public.wb_agent_daily a
    where a.day = v_day and a.tokens_total > 0
      and not exists (select 1 from public.wb_agent_logs l where l.agent = a.agent and l.day = v_day)
  ),
  audit as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'agent', a.agent, 'name', a.display_name,
      'tokensTotal', a.tokens_total, 'wasteTokens', a.waste_tokens,
      'tokensIn', a.tokens_in, 'tokensOut', a.tokens_out,
      'wasteRate', case when a.tokens_total > 0 then round(a.waste_tokens::numeric / a.tokens_total, 3) else 0 end,
      'advances', a.advances, 'reports', a.reports,
      'stalledTokens', coalesce(st.stalled, 0),
      'hasLog', exists (select 1 from public.wb_agent_logs l where l.agent = a.agent and l.day = a.day),
      'flags', to_jsonb(array_remove(array[
        case when not exists (select 1 from public.wb_agent_logs l where l.agent = a.agent and l.day = a.day)
             then 'no_log' end,
        case when a.tokens_total > 0 and a.advances = 0 then 'spend_no_progress' end,
        case when a.waste_tokens > 0 then 'declared_waste' end,
        case when coalesce(st.stalled, 0) > 0 then 'spend_on_stalled' end
      ], null))
    ) order by a.tokens_total desc), '[]'::jsonb) as items
    from public.wb_agent_daily a
    left join lateral (
      select sum(t.tokens_in + t.tokens_out)::bigint as stalled
      from public.wb_token_usage t
      join public.wb_project_board b on b.id = t.project_id
      where t.agent = a.agent and t.day = a.day and b.is_stuck
    ) st on true
    where a.day = v_day
  )
  select jsonb_build_object(
    'day', v_day,
    'generatedAt', now(),
    'plans', jsonb_build_object(
      'total', pc.total, 'open', pc.open, 'converted', pc.converted, 'items', pl.items),
    'projects', jsonb_build_object(
      'total', pr.total, 'active', pr.active, 'blocked', pr.blocked,
      'paused', pr.paused, 'monetized', pr.monetized, 'items', b.items),
    'funnel', f.items,
    'today', jsonb_build_object(
      'reports', dr.reports, 'projectsTouched', dr.projects_touched,
      'advances', dr.advances, 'tokens', dt.total, 'wasteTokens', dt.waste),
    'stuck', s.items,
    'feed', f2.items,
    'agents', ad.items,
    'participation', pa.items,
    'logs', lg.items,
    'unaudited', ua.items,
    'audit', au.items,
    'medians', md.items,
    'history', h.items
  )
  into v
  from day_tok dt, day_rep dr, board b, funnel f,
       (select * from plans) pl, plan_counts pc, proj_counts pr, stuck s,
       feed f2, agent_day ad, participation pa, logs lg, medians md, last_7 h, unaudited ua, audit au;
  return v;
end $$;

-- ── 权限：只给 service_role，匿名/登录用户一律不给 ────────────────────────
alter table public.wb_agents         enable row level security;
alter table public.wb_product_plans  enable row level security;
alter table public.wb_projects       enable row level security;
alter table public.wb_stage_events   enable row level security;
alter table public.wb_reports        enable row level security;
alter table public.wb_token_usage    enable row level security;
alter table public.wb_agent_logs     enable row level security;

revoke all on public.wb_agents, public.wb_product_plans, public.wb_projects,
              public.wb_stage_events, public.wb_reports, public.wb_token_usage,
              public.wb_agent_logs from anon, authenticated;
grant all on public.wb_agents, public.wb_product_plans, public.wb_projects,
             public.wb_stage_events, public.wb_reports, public.wb_token_usage,
             public.wb_agent_logs to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on public.wb_project_board, public.wb_agent_daily, public.wb_stage_median from anon, authenticated;
grant select on public.wb_project_board, public.wb_agent_daily, public.wb_stage_median to service_role;

revoke all on function public.wb_overview(date) from public, anon, authenticated;
grant execute on function public.wb_overview(date) to service_role;
revoke all on function public.wb_stage_index(text) from public, anon, authenticated;
grant execute on function public.wb_stage_index(text) to service_role;
