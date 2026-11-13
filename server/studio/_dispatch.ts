import { db, readJson } from '../lib';

/**
 * 派单队列：把「有任务」这件事放进队列，由传信员（relay）待命取走，
 * 再由传信员在自己所在的平台上叫醒对应 bot。
 * 队列里只放一行标题 + 指针（task_id / hint），不放任务正文——
 * 正文由 bot 自己拿 /api/studio/prompt 取，避免传信员把 token 花在搬运内容上。
 */

export const DISPATCH_STATUSES = ['pending', 'claimed', 'delivered', 'acked', 'expired', 'cancelled'] as const;
export const DISPATCH_OPEN = ['pending', 'claimed', 'delivered'] as const;
export const DISPATCH_KINDS = ['task', 'check', 'note'] as const;
export const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

type Row = Record<string, any>;

export type QueueResult = { row: Row; reused: boolean } | { error: string; status: number };

export type QueueInput = {
  taskId?: string | null;
  projectId?: string | null;
  targetAgent: string;
  relayAgent?: string | null;
  kind?: string;
  headline?: string | null;
  hint?: string | null;
  priority?: string;
  expiresInS?: number;
  createdBy?: string | null;
  note?: string | null;
};

async function one(path: string): Promise<Row | null> {
  try {
    const response = await db(path);
    const rows = await readJson<Row[]>(response);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

/** 目标 bot 没指定传信员时，用它登记时绑定的那一个。 */
async function relayFor(targetAgent: string): Promise<string | null> {
  const row = await one(`wb_agents?id=eq.${encodeURIComponent(targetAgent)}&select=relay_agent&limit=1`);
  return row?.relay_agent ?? null;
}

/** 只有标题、不含正文的提示行。 */
async function deriveHeadline(taskId: string, projectId: string | null): Promise<string | null> {
  const task = await one(`wb_tasks?id=eq.${taskId}&select=title,project_id&limit=1`);
  if (!task) return null;
  const pid = projectId ?? task.project_id;
  let projectName = '';
  if (pid) {
    const project = await one(`wb_projects?id=eq.${pid}&select=name&limit=1`);
    projectName = project?.name ?? '';
  }
  const title = String(task.title ?? '').trim();
  const line = projectName ? `【${projectName}】${title}` : title;
  return line.slice(0, 300) || null;
}

export async function queueDispatch(input: QueueInput): Promise<QueueResult> {
  const target = String(input.targetAgent ?? '').trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(target)) return { error: 'target_agent 无效。', status: 400 };

  let projectId = input.projectId ?? null;
  let headline = (input.headline ?? '').trim();
  if (input.taskId) {
    const task = await one(`wb_tasks?id=eq.${input.taskId}&select=title,project_id&limit=1`);
    if (!task) return { error: '任务不存在。', status: 404 };
    projectId = projectId ?? task.project_id ?? null;
  }
  if (!headline) {
    if (!input.taskId) return { error: '没有任务时要给 headline（一行标题）。', status: 400 };
    const derived = await deriveHeadline(input.taskId, projectId);
    if (!derived) return { error: '任务不存在。', status: 404 };
    headline = derived;
  }
  if (headline.length > 300) return { error: 'headline 最多 300 字。', status: 400 };

  const relay = input.relayAgent ?? (await relayFor(target));
  const priority = input.priority && PRIORITY_RANK[input.priority] !== undefined ? input.priority : 'medium';
  const expiresInS = Math.min(Math.max(Number(input.expiresInS) || 172800, 300), 2592000);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInS * 1000).toISOString();

  // 同一任务对同一目标只保留一条未走完的派单
  if (input.taskId) {
    const open = await one(
      `wb_dispatches?task_id=eq.${input.taskId}&target_agent=eq.${encodeURIComponent(target)}` +
      `&status=in.(${DISPATCH_OPEN.join(',')})&select=*&limit=1`,
    );
    if (open) {
      const patched = await db(`wb_dispatches?id=eq.${open.id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          headline,
          hint: input.hint ?? open.hint ?? null,
          priority,
          priority_rank: PRIORITY_RANK[priority],
          relay_agent: relay,
          expires_at: expiresAt,
          updated_at: now.toISOString(),
        }),
      });
      const rows = await readJson<Row[]>(patched);
      if (patched.ok && Array.isArray(rows) && rows[0]) return { row: rows[0], reused: true };
    }
  }

  const created = await db('wb_dispatches?select=*', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      kind: input.kind && DISPATCH_KINDS.includes(input.kind as any) ? input.kind : 'task',
      task_id: input.taskId ?? null,
      project_id: projectId,
      target_agent: target,
      relay_agent: relay,
      headline,
      hint: input.hint ?? null,
      priority,
      priority_rank: PRIORITY_RANK[priority],
      status: 'pending',
      expires_at: expiresAt,
      note: input.note ?? null,
      created_by: input.createdBy ?? null,
    }),
  });
  const rows = await readJson<Row[]>(created);
  if (!created.ok || !Array.isArray(rows) || !rows[0]) {
    return { error: '无法创建派单（目标 bot 是否已登记？）。', status: 400 };
  }
  return { row: rows[0], reused: false };
}

/** 任务完成 / 取消时，把它名下的未完成派单收尾。 */
export async function closeDispatches(taskId: string, status: 'acked' | 'cancelled', note: string): Promise<number> {
  if (!taskId) return 0;
  const now = new Date().toISOString();
  const body: Record<string, unknown> = { status, updated_at: now, note };
  if (status === 'acked') body.acked_at = now;
  try {
    const response = await db(
      `wb_dispatches?task_id=eq.${taskId}&status=in.(${DISPATCH_OPEN.join(',')})&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      },
    );
    const rows = await readJson<Row[]>(response);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/** 心跳：传信员/ bot 每轮待命都可以调，用来算“在线”。 */
export async function touchAgent(id: string): Promise<void> {
  if (!/^[a-z0-9_-]{2,32}$/.test(id)) return;
  try {
    await db(`wb_agents?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
  } catch {
    /* 心跳失败不该影响主流程 */
  }
}
