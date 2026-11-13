-- 值班室：bot 自助登记、bot 令牌、派单队列（传信员待命接口）。
-- 严格增量：只给 wb_agents 加可空/带默认值的列，新建 wb_agent_tokens / wb_dispatches。
-- 不碰 public.tasks / public.messages，不 drop 业务数据。可重复执行。

-- ── 1. bot 登记字段 ──────────────────────────────────────────────────────
alter table public.wb_agents add column if not exists capabilities  text[] not null default '{}';
alter table public.wb_agents add column if not exists contact       text;
alter table public.wb_agents add column if not exists endpoint      text;
alter table public.wb_agents add column if not exists relay_agent   text;
alter table public.wb_agents add column if not exists last_seen_at  timestamptz;
alter table public.wb_agents add column if not exists heartbeat_s   smallint not null default 60;
alter table public.wb_agents add column if not exists notes         text;
alter table public.wb_agents add column if not exists registered_by text;
alter table public.wb_agents add column if not exists updated_at    timestamptz not null default now();

-- 允许 kind = 'relay'（传信员），保留原有 bot / human
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.wb_agents'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%''human''%'
      and pg_get_constraintdef(oid) not like '%''relay''%'
  loop
    execute format('alter table public.wb_agents drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.wb_agents drop constraint if exists wb_agents_kind_v2;
alter table public.wb_agents
  add constraint wb_agents_kind_v2 check (kind in ('bot', 'human', 'relay'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wb_agents'::regclass and conname = 'wb_agents_heartbeat_range'
  ) then
    alter table public.wb_agents
      add constraint wb_agents_heartbeat_range check (heartbeat_s between 15 and 3600);
  end if;
end $$;

create index if not exists wb_agents_relay_idx on public.wb_agents (relay_agent);
create index if not exists wb_agents_kind_idx on public.wb_agents (kind, active);

-- ── 2. bot 令牌（只存 sha256；明文只在登记/轮换时返回一次）────────────────
create table if not exists public.wb_agent_tokens (
  agent_id     text primary key references public.wb_agents(id) on delete cascade,
  token_sha256 text not null unique check (char_length(token_sha256) = 64),
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);

create index if not exists wb_agent_tokens_hash_idx
  on public.wb_agent_tokens (token_sha256) where revoked = false;

-- ── 3. 派单队列（传信员待命接口的实体）──────────────────────────────────
create table if not exists public.wb_dispatches (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'task' check (kind in ('task', 'check', 'note')),
  task_id       uuid references public.wb_tasks(id) on delete cascade,
  project_id    uuid references public.wb_projects(id) on delete cascade,
  target_agent  text not null references public.wb_agents(id) on delete cascade,
  relay_agent   text references public.wb_agents(id) on delete set null,
  -- 只给传信员看的一行字：说“有任务”，不放任务正文
  headline      text not null check (char_length(headline) between 1 and 300),
  hint          text,
  priority      text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  priority_rank smallint not null default 1 check (priority_rank between 0 and 2),
  status        text not null default 'pending'
                check (status in ('pending', 'claimed', 'delivered', 'acked', 'expired', 'cancelled')),
  attempts      integer not null default 0 check (attempts >= 0),
  claimed_by    text references public.wb_agents(id) on delete set null,
  claimed_at    timestamptz,
  delivered_at  timestamptz,
  acked_at      timestamptz,
  expires_at    timestamptz not null default (now() + interval '2 days'),
  note          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists wb_dispatches_open_idx
  on public.wb_dispatches (status, priority_rank, created_at);
create index if not exists wb_dispatches_target_idx on public.wb_dispatches (target_agent, status);
create index if not exists wb_dispatches_relay_idx on public.wb_dispatches (relay_agent, status);
create index if not exists wb_dispatches_task_idx on public.wb_dispatches (task_id, status);

-- 同一任务对同一目标只保留一条未走完的派单，避免重复叫醒
create unique index if not exists wb_dispatches_open_uniq
  on public.wb_dispatches (task_id, target_agent)
  where status in ('pending', 'claimed', 'delivered');

-- ── 4. 值班台视图：谁在线、替谁待命、手上还有几单 ─────────────────────────
create or replace view public.wb_relay_desk as
select
  a.id, a.display_name, a.kind, a.platform, a.role, a.capabilities, a.contact, a.endpoint,
  a.relay_agent, a.active, a.notes, a.heartbeat_s, a.last_seen_at, a.created_at, a.updated_at,
  (a.last_seen_at is not null
   and a.last_seen_at > now() - (greatest(a.heartbeat_s, 60) * 3) * interval '1 second') as online,
  case when a.last_seen_at is null then null
       else floor(extract(epoch from (now() - a.last_seen_at)))::int end as seconds_since_seen,
  (select count(*) from public.wb_dispatches d
    where d.target_agent = a.id and d.status in ('pending', 'claimed', 'delivered'))::int as open_dispatches,
  (select count(*) from public.wb_dispatches d
    where d.relay_agent = a.id and d.status = 'pending')::int as waiting_dispatches
from public.wb_agents a;

revoke all on public.wb_relay_desk from anon, authenticated;
grant select on public.wb_relay_desk to service_role;

-- ── 5. 权限：新表同样只给 service_role ─────────────────────────────────
alter table public.wb_agent_tokens enable row level security;
alter table public.wb_dispatches  enable row level security;

revoke all on public.wb_agent_tokens, public.wb_dispatches from anon, authenticated;
grant all on public.wb_agent_tokens, public.wb_dispatches to service_role;
grant usage, select on all sequences in schema public to service_role;
