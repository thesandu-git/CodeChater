-- Studio（四层工作台）——严格增量迁移。
-- 只新建 wb_* 对象、给 wb_projects 加可空列、放宽我们自己的 status 约束。
-- 不碰 public.tasks / public.messages，也不 drop 任何业务数据。可重复执行。

-- ── 产品（项目之上的一层）──────────────────────────────────────────────────
create table if not exists public.wb_products (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 180),
  slug              text,
  summary           text not null default '' check (char_length(summary) <= 8000),
  plan              text not null default '' check (char_length(plan) <= 8000),
  research          text not null default '' check (char_length(research) <= 12000),
  target_user       text,
  monetization_model text,
  currency          text not null default 'LKR',
  price_hypothesis  numeric(12,2) check (price_hypothesis is null or price_hypothesis >= 0),
  status            text not null default 'active'
                    check (status in ('active', 'paused', 'done', 'killed')),
  owner_agent       text references public.wb_agents(id) on delete set null,
  target_monetized_at date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists wb_products_name_uniq on public.wb_products (lower(name));

-- ── 项目补列（全部可空/带默认值，旧行不受影响）─────────────────────────────
alter table public.wb_projects add column if not exists product_id   uuid references public.wb_products(id) on delete set null;
alter table public.wb_projects add column if not exists category     text;
alter table public.wb_projects add column if not exists purpose      text not null default '';
alter table public.wb_projects add column if not exists plan         text not null default '';
alter table public.wb_projects add column if not exists progress     smallint not null default 0;
alter table public.wb_projects add column if not exists priority     text not null default 'medium';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wb_projects'::regclass and conname = 'wb_projects_progress_range'
  ) then
    alter table public.wb_projects
      add constraint wb_projects_progress_range check (progress between 0 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wb_projects'::regclass and conname = 'wb_projects_priority_check'
  ) then
    alter table public.wb_projects
      add constraint wb_projects_priority_check check (priority in ('high', 'medium', 'low'));
  end if;
end $$;

-- 放宽 status：新增 not_started（未启动）。旧的 killed 仍表示取消。
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.wb_projects'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%''killed''%'
      and pg_get_constraintdef(oid) not like '%''not_started''%'
  loop
    execute format('alter table public.wb_projects drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.wb_projects drop constraint if exists wb_projects_status_v2;
alter table public.wb_projects
  add constraint wb_projects_status_v2
  check (status in ('not_started', 'active', 'blocked', 'paused', 'done', 'killed', 'cancelled'));

-- ── 任务（Kanban 的实体，支持子任务）──────────────────────────────────────
create table if not exists public.wb_tasks (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.wb_projects(id) on delete cascade,
  parent_id      uuid references public.wb_tasks(id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 200),
  plan           text not null default '' check (char_length(plan) <= 8000),
  status         text not null default 'on_track'
                 check (status in ('on_track', 'at_risk', 'blocked', 'completed', 'on_hold')),
  priority       text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  assignee_agent text references public.wb_agents(id) on delete set null,
  requester_agent text references public.wb_agents(id) on delete set null,
  owner_required boolean not null default false,
  progress       smallint not null default 0,
  start_at       date,
  due_at         date,
  blocked_reason text,
  order_index    integer not null default 0,
  source         text not null default 'api' check (char_length(source) <= 40),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wb_tasks'::regclass and conname = 'wb_tasks_progress_range'
  ) then
    alter table public.wb_tasks add constraint wb_tasks_progress_range check (progress between 0 and 100);
  end if;
end $$;

create index if not exists wb_tasks_project_idx on public.wb_tasks (project_id, status, order_index);
create index if not exists wb_tasks_status_idx on public.wb_tasks (status, due_at);

-- 任务状态变化历史（时间线 + 检查申请都写这里）
create table if not exists public.wb_task_events (
  id          bigserial primary key,
  task_id     uuid not null references public.wb_tasks(id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor_agent text references public.wb_agents(id) on delete set null,
  note        text,
  day         date not null default ((now() at time zone 'Asia/Colombo')::date),
  created_at  timestamptz not null default now()
);

create index if not exists wb_task_events_task_idx on public.wb_task_events (task_id, created_at desc);
create index if not exists wb_task_events_day_idx on public.wb_task_events (day);

-- ── 里程碑（甘特图上的标记）───────────────────────────────────────────────
create table if not exists public.wb_milestones (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.wb_projects(id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 200),
  due_at         date not null,
  done_at        date,
  owner_required boolean not null default false,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists wb_milestones_project_idx on public.wb_milestones (project_id, due_at);

-- ── 日程（日历层）────────────────────────────────────────────────────────
create table if not exists public.wb_schedule (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 1 and 200),
  detail         text not null default '' check (char_length(detail) <= 4000),
  project_id     uuid references public.wb_projects(id) on delete cascade,
  product_id     uuid references public.wb_products(id) on delete set null,
  kind           text not null default 'work'
                 check (kind in ('work', 'review', 'decision', 'owner', 'milestone', 'payment')),
  owner_required boolean not null default false,
  start_at       timestamptz not null,
  end_at         timestamptz,
  agent          text references public.wb_agents(id) on delete set null,
  done           boolean not null default false,
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists wb_schedule_day_idx on public.wb_schedule (start_at);
create index if not exists wb_schedule_project_idx on public.wb_schedule (project_id, start_at);

-- ── 研究 / 规划文档 ──────────────────────────────────────────────────────
create table if not exists public.wb_docs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid references public.wb_projects(id) on delete cascade,
  product_id uuid references public.wb_products(id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 240),
  kind       text not null default 'research'
             check (kind in ('research', 'spec', 'report', 'note')),
  url        text,
  body       text not null default '' check (char_length(body) <= 20000),
  agent      text references public.wb_agents(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists wb_docs_project_idx on public.wb_docs (project_id, created_at desc);
create index if not exists wb_docs_product_idx on public.wb_docs (product_id, created_at desc);

-- ── 视图：项目板上带产品、进度、任务计数 ──────────────────────────────────
create or replace view public.wb_studio_projects as
select
  p.id, p.name, p.slug, p.stage, p.status, p.owner_agent,
  p.product_id, pr.name as product_name,
  p.category, p.purpose, p.plan, p.progress, p.priority,
  p.repo_url, p.preview_url, p.monetization_model, p.currency, p.monthly_revenue,
  p.blocked_reason, p.blocker_owner, p.summary, p.plan_id,
  p.started_at, p.stage_entered_at, p.last_progress_at, p.monetized_at, p.target_launch_at,
  floor(extract(epoch from (now() - p.stage_entered_at)) / 86400)::int as days_in_stage,
  floor(extract(epoch from (now() - p.last_progress_at)) / 86400)::int as days_since_progress,
  floor(extract(epoch from (now() - p.started_at)) / 86400)::int as days_since_start,
  case when p.monetized_at is null then null
       else floor(extract(epoch from (p.monetized_at - p.started_at)) / 86400)::int end as days_to_revenue,
  (p.status = 'blocked'
   or (p.status = 'active' and now() - p.last_progress_at > interval '3 days')) as is_stuck,
  (select count(*) from public.wb_tasks t where t.project_id = p.id)::int as task_count,
  (select count(*) from public.wb_tasks t where t.project_id = p.id and t.status = 'completed')::int as task_done,
  (select count(*) from public.wb_tasks t where t.project_id = p.id and t.status = 'blocked')::int as task_blocked,
  r.agent as last_agent, r.summary as last_report, r.created_at as last_report_at
from public.wb_projects p
left join public.wb_products pr on pr.id = p.product_id
left join lateral (
  select agent, summary, created_at
  from public.wb_reports
  where project_id = p.id
  order by created_at desc
  limit 1
) r on true;

revoke all on public.wb_studio_projects from anon, authenticated;
grant select on public.wb_studio_projects to service_role;

-- ── 权限：新表同样只给 service_role ──────────────────────────────────────
alter table public.wb_products    enable row level security;
alter table public.wb_tasks       enable row level security;
alter table public.wb_task_events enable row level security;
alter table public.wb_milestones  enable row level security;
alter table public.wb_schedule    enable row level security;
alter table public.wb_docs        enable row level security;

revoke all on public.wb_products, public.wb_tasks, public.wb_task_events,
              public.wb_milestones, public.wb_schedule, public.wb_docs
  from anon, authenticated;

grant all on public.wb_products, public.wb_tasks, public.wb_task_events,
             public.wb_milestones, public.wb_schedule, public.wb_docs
  to service_role;

grant usage, select on all sequences in schema public to service_role;
