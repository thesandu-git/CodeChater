-- Adds the third agent identity, "dev2", to the task queue.
--
-- Existing deployments built from supabase/schema.sql carry inline CHECK
-- constraints on tasks.assigned_to and messages.sender that only allow the
-- original agents. Those inline constraints get server-generated names, so the
-- blocks below find and drop whatever CHECK constraint guards each column
-- instead of guessing a name. Re-running this migration is safe.

do $$
declare
  target record;
begin
  for target in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'tasks'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%assigned_to%'
  loop
    execute format('alter table public.tasks drop constraint %I', target.conname);
  end loop;

  for target in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'messages'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%sender%'
  loop
    execute format('alter table public.messages drop constraint %I', target.conname);
  end loop;
end $$;

alter table public.tasks
  add constraint tasks_assigned_to_check
  check (assigned_to in ('grokbot', 'codex', 'dev2'));

alter table public.messages
  add constraint messages_sender_check
  check (sender in ('owner', 'grokbot', 'codex', 'dev2'));
