import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import { addDays, json, requireIdentity, text, today, uuid } from './_shared';

type Row = Record<string, any>;

async function one(path: string): Promise<Row | null> {
  const res = await db(path);
  const data = await readJson<Row[]>(res);
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * 执行层：申请检查。
 * 把一条任务标成“有风险/受阻”，并在日程里给主人放一条必须亲自看的检查项。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const who = await requireIdentity(req, res);
  if (!who) return;

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = uuid(body.task_id);
    const projectIdIn = uuid(body.project_id);
    if (taskId === undefined || projectIdIn === undefined) return json(res, 400, { error: 'id 无效。' });

    const reason = text(body.reason, 1000);
    if (!reason) return json(res, 400, { error: '说明卡在哪：reason 必填。' });

    const task = taskId ? await one(`wb_tasks?id=eq.${taskId}&select=*&limit=1`) : null;
    const projectId = task?.project_id ?? projectIdIn;
    if (!projectId) return json(res, 400, { error: '给 task_id 或 project_id。' });
    const project = await one(`wb_studio_projects?id=eq.${projectId}&select=*&limit=1`);
    if (!project) return json(res, 404, { error: '项目不存在。' });

    const actor = who.role === 'agent' ? who.id : null;
    const subject = task ? task.title : project.name;

    if (task && task.status !== 'completed') {
      const nextStatus = task.status === 'blocked' ? 'blocked' : 'at_risk';
      await db(`wb_tasks?id=eq.${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: nextStatus,
          blocked_reason: reason,
          updated_at: new Date().toISOString(),
        }),
      });
      await db('wb_task_events', {
        method: 'POST',
        body: JSON.stringify({
          task_id: task.id, from_status: task.status, to_status: nextStatus,
          actor_agent: actor, note: `申请检查：${reason}`,
        }),
      });
    }

    const day = text(body.day, 10) ?? addDays(today(), 1);
    const review = await db('wb_schedule?select=*', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        title: `检查：${subject}`,
        detail: reason,
        project_id: projectId,
        product_id: project.product_id ?? null,
        kind: 'review',
        owner_required: true,
        start_at: `${day}T09:00:00+05:30`,
        agent: actor,
      }),
    });
    const reviewRows = await readJson<Row[]>(review);

    const report = await db('wb_reports?select=*', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        project_id: projectId,
        agent: actor,
        kind: 'decision',
        summary: `申请检查：${subject}`.slice(0, 500),
        detail: reason,
        outcome: 'unchanged',
        blocked: Boolean(task),
        blocker_owner: 'Prasad',
        source: 'studio-check',
      }),
    });
    const reportRows = await readJson<Row[]>(report);

    return json(res, 201, {
      ok: true,
      taskId: task?.id ?? null,
      projectId,
      reviewAt: day,
      review: Array.isArray(reviewRows) ? reviewRows[0] ?? null : null,
      report: Array.isArray(reportRows) ? reportRows[0] ?? null : null,
    });
  } catch (error) {
    return json(res, 503, { error: '检查申请失败。', detail: String((error as Error)?.message ?? error) });
  }
}
