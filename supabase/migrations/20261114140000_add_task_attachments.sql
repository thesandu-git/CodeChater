-- 任务附件：文件存 Supabase Storage（私有桶），元数据存这张表。
-- 严格增量：只新建表与桶，不碰既有对象。可重复执行。

create table if not exists public.wb_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.wb_tasks(id) on delete cascade,
  filename      text not null check (char_length(filename) between 1 and 200),
  mime          text not null default 'application/octet-stream' check (char_length(mime) <= 120),
  size_bytes    bigint not null default 0 check (size_bytes >= 0),
  storage_path  text not null unique,
  uploaded_by   text not null default 'owner',
  note          text check (note is null or char_length(note) <= 500),
  created_at    timestamptz not null default now()
);

create index if not exists wb_attachments_task_idx
  on public.wb_attachments (task_id, created_at desc);

alter table public.wb_attachments enable row level security;
grant all on public.wb_attachments to service_role;

-- 私有桶：只能通过签名 URL 读；单文件上限 50MB（Vercel 函数体只有 4.5MB，大文件走直传）。
insert into storage.buckets (id, name, public, file_size_limit)
values ('studio-attachments', 'studio-attachments', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
