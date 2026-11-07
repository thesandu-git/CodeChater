create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_by text not null default 'owner' check (created_by in ('owner', 'grokbot')),
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 12000),
  assigned_to text not null check (assigned_to in ('grokbot', 'codex', 'dev2')),
  status text not null default 'pending' check (status in ('pending', 'working', 'needs_input', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  sender text not null check (sender in ('owner', 'grokbot', 'codex', 'dev2')),
  body text not null check (char_length(body) between 1 and 12000),
  created_at timestamptz not null default now()
);

create index if not exists tasks_owner_created_idx on public.tasks(owner_id, created_at desc);
create index if not exists tasks_queue_idx on public.tasks(status, created_at) where status = 'pending';
create index if not exists messages_task_created_idx on public.messages(task_id, created_at);

alter table public.tasks enable row level security;
alter table public.messages enable row level security;

drop policy if exists "owners read own tasks" on public.tasks;
create policy "owners read own tasks" on public.tasks
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "owners read messages on own tasks" on public.messages;
create policy "owners read messages on own tasks" on public.messages
  for select to authenticated using (
    exists (select 1 from public.tasks t where t.id = task_id and t.owner_id = auth.uid())
  );

grant select on public.tasks, public.messages to authenticated;
grant all on public.tasks, public.messages to service_role;
