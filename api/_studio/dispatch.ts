import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../_lib';
import {
  DISPATCH_KINDS, DISPATCH_OPEN, DISPATCH_STATUSES, PRIORITY_RANK, closeDispatches, queueDispatch,
} from './_dispatch';
import { json, num, oneOf, requireIdentity, text, uuid } from './_shared';

/**
 * 派单（管理员侧）。
 * 派一条 = 在队列里放一行「有任务」，交给目标 bot 的传信员去叫醒它；
 * 队列不装任务正文，bot 醒了自己去 /api/studio/prompt 取。
 */

type Row = Record<string, any>;

function statusFilter(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  if (raw === 'open') return [...DISPATCH_OPEN];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [];
  for (const s of list) if (!(DISPATCH_STATUSES as readonly string[]).includes(s)) return null;
  return list;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const statuses = statusFilter(req.query.status);
      if (statuses === null) return json(res, 400, { error: `status 只能是 open 或 ${DISPATCH_STATUSES.join(' / ')} 的组合。` });
      const target = text(req.query.target, 32);
      const relay = text(req.query.relay, 32);
      const task = uuid(req.query.task);
      const limit = num(req.query.limit, 1, 500) ?? 100;
      if (target === undefined || relay === undefined) return json(res, 400, { error: 'target/relay 太长。' });
      if (task === undefined) return json(res, 400, { error: 'task id 无效。' });

      const filters = [
        statuses.length ? `status=in.(${statuses.join(',')})` : '',
        target ? `target_agent=eq.${encodeURIComponent(target)}` : '',
        relay ? `relay_agent=eq.${encodeURIComponent(relay)}` : '',
        task ? `task_id=eq.${task}` : '',
      ].filter(Boolean);
      const response = await db(`wb_dispatches?select=*${filters.length ? `&${filters.join('&')}` : ''}` +
        `&order=created_at.desc&limit=${limit}`);
      const rows = await readJson<Row[]>(response);
      if (!response.ok || !Array.isArray(rows)) return json(res, 503, { error: '读取派单失败。', detail: rows });

      const summaryRes = await db(`wb_dispatches?select=status&created_at=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&limit=5000`);
      const summaryRows = await readJson<Row[]>(summaryRes);
      const counts: Record<string, number> = Object.fromEntries(DISPATCH_STATUSES.map((s) => [s, 0]));
      for (const r of Array.isArray(summaryRows) ? summaryRows : []) counts[r.status] = (counts[r.status] ?? 0) + 1;

      return json(res, 200, {
        dispatches: rows,
        counts,
        open: DISPATCH_OPEN.reduce((sum, s) => sum + (counts[s] ?? 0), 0),
        hint: '传信员待命：GET /api/studio/inbox?relay=<id>&wait=25；送达回执：PATCH /api/studio/dispatch?id=<id> {status:"delivered"}',
      });
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = uuid(body.task_id);
      if (taskId === undefined) return json(res, 400, { error: 'task_id 无效。' });

      let target = text(body.target_agent, 32);
      if (target === undefined) return json(res, 400, { error: 'target_agent 太长。' });
      if (!target && taskId) {
        const taskRes = await db(`wb_tasks?id=eq.${taskId}&select=assignee_agent&limit=1`);
        const taskRows = await readJson<Row[]>(taskRes);
        target = taskRows?.[0]?.assignee_agent ?? null;
      }
      if (!target) return json(res, 400, { error: '需要 target_agent（任务没指定负责人时要显式给）。' });

      const kind = body.kind === undefined ? 'task' : oneOf(body.kind, DISPATCH_KINDS);
      if (!kind) return json(res, 400, { error: 'kind 只能是 task / check / note。' });
      const priority = body.priority === undefined ? 'medium' : oneOf(body.priority, ['high', 'medium', 'low'] as const);
      if (!priority) return json(res, 400, { error: 'priority 只能是 high / medium / low。' });
      const headline = text(body.headline, 300);
      const hint = text(body.hint, 500);
      const relayAgent = text(body.relay_agent, 32);
      if (headline === undefined || hint === undefined || relayAgent === undefined) {
        return json(res, 400, { error: 'headline ≤300、hint ≤500、relay_agent ≤32。' });
      }

      const result = await queueDispatch({
        taskId,
        projectId: uuid(body.project_id) ?? null,
        targetAgent: target,
        relayAgent,
        kind,
        headline,
        hint,
        priority,
        expiresInS: num(body.expires_in_s, 300, 2592000) ?? undefined,
        createdBy: who.id,
        note: text(body.note, 400) ?? null,
      });
      if ('error' in result) return json(res, result.status, { error: result.error });
      return json(res, result.reused ? 200 : 201, {
        dispatch: result.row,
        reused: result.reused,
        note: result.reused ? '同一任务同一目标已有未完成派单，已更新它。' : '已入队，等传信员来取。',
      });
    }

    if (req.method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = uuid(req.query.task_id);

      // 按任务收尾：任务完成/取消时用
      if (taskId) {
        const status = oneOf(body.status, ['acked', 'cancelled'] as const);
        if (!status) return json(res, 400, { error: '按 task_id 收尾时 status 只能是 acked 或 cancelled。' });
        const closed = await closeDispatches(taskId, status, text(body.note, 400) ?? '任务已收尾');
        return json(res, 200, { closed, task_id: taskId, status });
      }

      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要 ?id= 或 ?task_id=' });
      const currentRes = await db(`wb_dispatches?id=eq.${id}&select=*&limit=1`);
      const currentRows = await readJson<Row[]>(currentRes);
      const current = currentRows?.[0] ?? null;
      if (!current) return json(res, 404, { error: '派单不存在。' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.status !== undefined) {
        const status = oneOf(body.status, DISPATCH_STATUSES);
        if (!status) return json(res, 400, { error: `status 只能是 ${DISPATCH_STATUSES.join(' / ')}。` });
        patch.status = status;
        const now = new Date().toISOString();
        if (status === 'claimed') {
          patch.claimed_at = now;
          patch.claimed_by = who.role === 'agent' ? who.id : text(body.claimed_by, 32) ?? null;
          patch.attempts = (Number(current.attempts) || 0) + 1;
        }
        if (status === 'delivered') patch.delivered_at = now;
        if (status === 'acked') patch.acked_at = now;
      }
      if (body.relay_agent !== undefined) {
        const relay = text(body.relay_agent, 32);
        if (relay === undefined) return json(res, 400, { error: 'relay_agent 太长。' });
        patch.relay_agent = relay;
      }
      if (body.headline !== undefined) {
        const headline = text(body.headline, 300);
        if (!headline) return json(res, 400, { error: 'headline 必填且 ≤300 字。' });
        patch.headline = headline;
      }
      if (body.priority !== undefined) {
        const priority = oneOf(body.priority, ['high', 'medium', 'low'] as const);
        if (!priority) return json(res, 400, { error: 'priority 只能是 high / medium / low。' });
        patch.priority = priority;
        patch.priority_rank = PRIORITY_RANK[priority];
      }
      if (body.expires_in_s !== undefined) {
        const seconds = num(body.expires_in_s, 300, 2592000);
        if (seconds === null) return json(res, 400, { error: 'expires_in_s 必须在 300–2592000 秒。' });
        patch.expires_at = new Date(Date.now() + seconds * 1000).toISOString();
      }
      if (body.note !== undefined) patch.note = text(body.note, 400) ?? null;

      const updated = await db(`wb_dispatches?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson<Row[]>(updated);
      if (!updated.ok || !Array.isArray(rows) || !rows[0]) {
        return json(res, 400, { error: '无法更新派单。', detail: rows });
      }
      return json(res, 200, rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要 ?id=' });
      const updated = await db(`wb_dispatches?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'cancelled', note: '已取消', updated_at: new Date().toISOString() }),
      });
      const rows = await readJson<Row[]>(updated);
      if (!updated.ok || !Array.isArray(rows) || !rows[0]) return json(res, 404, { error: '派单不存在。' });
      return json(res, 200, { cancelled: true, dispatch: rows[0] });
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '派单接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
