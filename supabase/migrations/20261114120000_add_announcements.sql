-- 公告栏：平台层面的更新 / 修 bug / 通知，传信员轮询一次就能判断「有没有新东西」。
-- 严格增量：只新建 public.wb_announcements，不碰既有表。可重复执行。

create table if not exists public.wb_announcements (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'notice'
                check (kind in ('update', 'fix', 'notice', 'incident')),
  severity      text not null default 'info'
                check (severity in ('info', 'important', 'critical')),
  audience      text not null default 'all'
                check (audience in ('all', 'relay', 'bot', 'owner')),
  version       text check (version is null or char_length(version) <= 40),
  title         text not null check (char_length(title) between 1 and 200),
  body          text not null default '' check (char_length(body) <= 8000),
  created_by    text not null default 'owner',
  published_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived      boolean not null default false,
  archived_at   timestamptz
);

-- 列表按发布时间倒序；传信员只查未归档的。
create index if not exists wb_announcements_published_idx
  on public.wb_announcements (published_at desc);

create index if not exists wb_announcements_open_idx
  on public.wb_announcements (published_at desc) where archived = false;

-- 和别的 wb_* 一致：只给 service_role，浏览器/匿名令牌不经 PostgREST 直读。
alter table public.wb_announcements enable row level security;
grant all on public.wb_announcements to service_role;
