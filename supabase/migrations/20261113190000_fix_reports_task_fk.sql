-- wb_reports.task_id 原来外键指向旧的 public.tasks（老任务桥的表），
-- 于是 POST /api/studio/report 带上 studio 的 wb_tasks.id 一律被拒：
-- 23503, Key (task_id)=(...) is not present in table "tasks"。
-- 改成指向 public.wb_tasks；删任务时把汇报的 task_id 置空，历史汇报保留。可重复执行。

alter table public.wb_reports drop constraint if exists wb_reports_task_id_fkey;

alter table public.wb_reports
  add constraint wb_reports_task_id_fkey foreign key (task_id) references public.wb_tasks(id) on delete set null;
