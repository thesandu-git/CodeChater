import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../_lib';
import { closeDispatches, queueDispatch } from './_dispatch';
import {
  PRIORITIES, TASK_STATUSES, json, num, oneOf, requireIdentity, text, uuid,
} from './_shared';

type Row = Record<string, any>;

/**
 * assignee_agent / requester_agent 都外键指向 wb_agents(id)。
 * 没登记的 id 会被 Postgres 用 23503 顶回来，长得像事故；这里提前换成人话。
 * 查不动（网络/后端故障）返回 false，让写入照常尝试，由下面的外键兜底。
 */
async function unregistered(agentId: string): Promise<boolean> {
  try {
    const response = await db(`wb_agents?id=eq.${encodeURIComponent(agentId)}&select=id&limit=1`);
    const rows = await readJson<Row[]>(response);
    if (!response.ok || !Array.isArray(rows)) return false;
    return rows.length === 0;
  } catch {
    return false;
  }
}

function notRegistered(agentId: string, role: string) {
  return {
    error: `${role} ${agentId} 还没登记：先 POST /api/studio/agents 登记它，或换成已登记的 id。`,
    hint: '已登记的 id 见 GET /api/studio/agents。',
  };
}

/** 兜底：写入已经撞了外键时，把 23503 翻译成同一句中文。 */
function foreignKeyColumn(payload: unknown): string | null {
  const body = (Array.isArray(payload) ? payload[0] : payload) as Row | null;
  const message = String(body?.details ?? body?.detail ?? body?.message ?? '');
  if (body?.code !== '23503' && !/is not present in table/i.test(message)) return null;
  const match = /key \((.+?)\)=/i.exec(message) ?? /Key \((.+?)\)/i.exec(message);
  return match ? match[1] : 'agent';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      // 单条：?task=<id>（prompt 的手感），?id= 也认
      const single = uuid(req.query.task ?? req.query.id);
      if (single === undefined) return json(res, 400, { error: '任务 id 无效。' });
      if (single) {
        const response = await db(`wb_tasks?id=eq.${single}&select=*&limit=1`);
        const data = await readJson<Row[]>(response);
        if (!response.ok) return json(res, response.status, data);
        const task = Array.isArray(data) ? data[0] : null;
        if (!task) {
          return json(res, 404, {
            error: '没有这个任务。',
            hint: '列表用 GET /api/studio/tasks?project=<项目 id>，别用 ?task= 查不存在的 id。',
          });
        }
        return json(res, 200, task);
      }
      const project = uuid(req.query.project);
      const status = oneOf(req.query.status, TASK_STATUSES);
      if (project === undefined) return json(res, 400, { error: '项目 id 无效。' });
      const filters = [project ? `project_id=eq.${project}` : '', status ? `status=eq.${status}` : '']
        .filter(Boolean).join('&');
      const response = await db(`wb_tasks?select=*&${filters ? `${filters}&` : ''}order=order_index.asc&limit=1000`);
      return json(res, response.status, await readJson(response));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST') {
      const projectId = uuid(body.project_id);
      if (!projectId) return json(res, 400, { error: '任务必须挂在一个项目上（project_id）。' });
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
        return json(res, 400, { error: '任务标题必填（≤200 字）。' });
      }
      const parentId = uuid(body.parent_id);
      if (parentId === undefined) return json(res, 400, { error: '父任务 id 无效。' });
      const status = oneOf(body.status, TASK_STATUSES) ?? 'on_track';

      const assignee = text(body.assignee_agent, 32) ?? null;
      if (assignee && await unregistered(assignee)) return json(res, 400, notRegistered(assignee, '执行方'));
      const requester = text(body.requester_agent, 32) ?? (who.role === 'agent' ? who.id : null);
      if (requester && requester !== assignee && await unregistered(requester)) {
        return json(res, 400, notRegistered(requester, '派任务的人'));
      }

      const row: Record<string, unknown> = {
        project_id: projectId,
        parent_id: parentId,
        title: body.title.trim(),
        plan: text(body.plan, 8000) ?? '',
        status,
        priority: oneOf(body.priority, PRIORITIES) ?? 'medium',
        assignee_agent: assignee,
        requester_agent: requester,
        owner_required: Boolean(body.owner_required),
        progress: status === 'completed' ? 100 : num(body.progress, 0, 100) ?? 0,
        start_at: text(body.start_at, 10) ?? null,
        due_at: text(body.due_at, 10) ?? null,
        blocked_reason: text(body.blocked_reason, 400) ?? null,
        order_index: num(body.order_index, 0, 1e6) ?? 0,
        source: who.role === 'agent' ? `agent:${who.id}` : 'owner',
        completed_at: status === 'completed' ? new Date().toISOString() : null,
      };
      const created = await db('wb_tasks?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const rows = await readJson<Record<string, any>[]>(created);
      if (!created.ok) {
        const column = foreignKeyColumn(rows);
        if (column === 'assignee_agent') return json(res, 400, notRegistered(String(row.assignee_agent), '执行方'));
        if (column === 'requester_agent') return json(res, 400, notRegistered(String(row.requester_agent), '派任务的人'));
        return json(res, 400, { error: '无法创建任务。', detail: rows });
      }
      await db('wb_task_events', {
        method: 'POST',
        body: JSON.stringify({
          task_id: rows[0].id, from_status: null, to_status: status,
          actor_agent: who.role === 'agent' ? who.id : null,
          note: '任务创建',
        }),
      });

      // 有负责人就默认派单（body.dispatch = false 可关掉）：
      // 队列里只放一行「有任务」，等传信员取走再去叫醒 bot。
      let dispatch: Record<string, unknown> | null = null;
      if (body.dispatch !== false && row.assignee_agent && status !== 'completed') {
        try {
          const queued = await queueDispatch({
            taskId: rows[0].id,
            targetAgent: String(row.assignee_agent),
            createdBy: who.id,
            note: '任务创建时自动派单',
          });
          dispatch = 'row' in queued ? queued.row : { error: queued.error };
        } catch {
          dispatch = null;
        }
      }

      return json(res, 201, { ...rows[0], dispatch });
    }

    if (req.method === 'PATCH') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要任务 id。' });
      const currentRes = await db(`wb_tasks?id=eq.${id}&select=*&limit=1`);
      const currentRows = await readJson<Record<string, any>[]>(currentRes);
      const task = Array.isArray(currentRows) ? currentRows[0] : null;
      if (!currentRes.ok || !task) return json(res, 404, { error: '任务不存在。' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      let statusChanged = false;
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
          return json(res, 400, { error: '任务标题必填（≤200 字）。' });
        }
        patch.title = body.title.trim();
      }
      if (body.plan !== undefined) {
        const value = text(body.plan, 8000);
        if (value === undefined) return json(res, 400, { error: '任务规划太长。' });
        patch.plan = value ?? '';
      }
      if (body.status !== undefined) {
        const status = oneOf(body.status, TASK_STATUSES);
        if (!status) return json(res, 400, { error: '未知任务状态。' });
        if (status !== task.status) {
          patch.status = status;
          statusChanged = true;
          patch.completed_at = status === 'completed' ? new Date().toISOString() : null;
          if (status === 'completed') patch.progress = 100;
          if (status === 'blocked' && body.blocked_reason === undefined && !task.blocked_reason) {
            patch.blocked_reason = '未说明原因';
          }
        }
      }
      if (body.priority !== undefined) {
        const priority = oneOf(body.priority, PRIORITIES);
        if (!priority) return json(res, 400, { error: '未知优先级。' });
        patch.priority = priority;
      }
      if (body.assignee_agent !== undefined) {
        const assignee = text(body.assignee_agent, 32);
        if (assignee === undefined) return json(res, 400, { error: '执行方 id 太长（≤32 位）。' });
        if (assignee && await unregistered(assignee)) return json(res, 400, notRegistered(assignee, '执行方'));
        patch.assignee_agent = assignee;
      }
      if (body.owner_required !== undefined) patch.owner_required = Boolean(body.owner_required);
      if (body.progress !== undefined) {
        const progress = num(body.progress, 0, 100);
        if (progress === null) return json(res, 400, { error: '进度必须是 0–100。' });
        patch.progress = Math.round(progress);
      }
      for (const field of ['start_at', 'due_at', 'blocked_reason'] as const) {
        if (body[field] === undefined) continue;
        const value = text(body[field], field === 'blocked_reason' ? 400 : 10);
        if (value === undefined) return json(res, 400, { error: `${field} 太长。` });
        patch[field] = value;
      }
      if (body.order_index !== undefined) {
        const order = num(body.order_index, 0, 1e6);
        if (order === null) return json(res, 400, { error: 'order_index 无效。' });
        patch.order_index = order;
      }

      const updated = await db(`wb_tasks?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson<Record<string, any>[]>(updated);
      if (!updated.ok) {
        const column = foreignKeyColumn(rows);
        if (column === 'assignee_agent') return json(res, 400, notRegistered(String(patch.assignee_agent), '执行方'));
        if (column === 'requester_agent') return json(res, 400, notRegistered(String(patch.requester_agent), '派任务的人'));
        return json(res, 400, { error: '无法更新任务。', detail: rows });
      }
      if (statusChanged) {
        await db('wb_task_events', {
          method: 'POST',
          body: JSON.stringify({
            task_id: id, from_status: task.status, to_status: patch.status,
            actor_agent: who.role === 'agent' ? who.id : null,
            note: text(body.note, 400) ?? null,
          }),
        });
      }

      // 换负责人 → 给新负责人重新派一单；任务完成 → 把它名下未完成的派单收尾
      const nextAssignee = rows[0].assignee_agent ?? null;
      if (body.assignee_agent !== undefined && nextAssignee && nextAssignee !== task.assignee_agent
        && body.dispatch !== false && rows[0].status !== 'completed') {
        try {
          await queueDispatch({
            taskId: id, targetAgent: nextAssignee, createdBy: who.id, note: '负责人变更',
          });
        } catch { /* 派单失败不该挡住任务更新 */ }
      }
      if (rows[0].status === 'completed' && task.status !== 'completed') {
        try {
          await closeDispatches(id, 'acked', '任务已完成');
        } catch { /* 同上 */ }
      }

      return json(res, 200, rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要任务 id。' });
      const deleted = await db(`wb_tasks?id=eq.${id}`, { method: 'DELETE' });
      return json(res, deleted.status === 204 ? 204 : deleted.status, null);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '任务接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
