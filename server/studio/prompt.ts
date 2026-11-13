import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import { json, requireIdentity, uuid } from './_shared';

type Row = Record<string, any>;

async function one(path: string): Promise<Row | null> {
  const res = await db(path);
  const data = await readJson<Row[]>(res);
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function list(path: string): Promise<Row[]> {
  const res = await db(path);
  const data = await readJson<Row[]>(res);
  return Array.isArray(data) ? data : [];
}

function origin(req: VercelRequest): string {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3120';
  const proto = (req.headers['x-forwarded-proto'] as string) || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * 执行层：给 bot 一份可以直接塞进上下文的“任务执行摘要 prompt”。
 * 任务 id、项目 id 都能查；给项目 id 时取该项目当前最该做的那条任务。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const who = await requireIdentity(req, res);
  if (!who) return;

  try {
    const taskId = uuid(req.query.task);
    const projectId = uuid(req.query.project);
    if (taskId === undefined || projectId === undefined) return json(res, 400, { error: 'id 无效。' });
    if (!taskId && !projectId) return json(res, 400, { error: '给 task 或 project。' });

    let task: Row | null = null;
    if (taskId) {
      task = await one(`wb_tasks?id=eq.${taskId}&select=*&limit=1`);
      if (!task) return json(res, 404, { error: '任务不存在。' });
    } else {
      const open = await list(
        `wb_tasks?project_id=eq.${projectId}&status=neq.completed&select=*&order=order_index.asc&limit=20`,
      );
      const rank = (s: string) => ({ blocked: 0, at_risk: 1, on_track: 2, on_hold: 3 }[s] ?? 4);
      task = open.sort((a, b) => rank(a.status) - rank(b.status))[0] ?? null;
      if (!task) return json(res, 404, { error: '这个项目没有未完成的任务。' });
    }

    const project = await one(`wb_studio_projects?id=eq.${task.project_id}&select=*&limit=1`);
    if (!project) return json(res, 404, { error: '任务所属项目不存在。' });
    const prod = project.product_id
      ? await one(`wb_products?id=eq.${project.product_id}&select=*&limit=1`)
      : null;
    const subtasks = await list(`wb_tasks?parent_id=eq.${task.id}&select=*&order=order_index.asc&limit=50`);
    const milestones = await list(`wb_milestones?project_id=eq.${task.project_id}&select=*&order=due_at.asc&limit=20`);
    const siblings = await list(`wb_tasks?project_id=eq.${task.project_id}&select=*&order=order_index.asc&limit=100`);

    const base = origin(req);
    const label: Record<string, string> = {
      on_track: '正常推进', at_risk: '有风险', blocked: '受阻', on_hold: '暂停', completed: '已完成',
    };
    const priority: Record<string, string> = { high: '高', medium: '中', low: '低' };

    const prompt = [
      `# 任务执行摘要 · ${task.title}`,
      '',
      `你在为「${prod?.name ?? project.product_name ?? '未归产品'}」产品下的「${project.name}」项目执行一条任务。`,
      '',
      '## 任务',
      `- 任务 id：${task.id}`,
      `- 状态：${label[task.status] ?? task.status} · 优先级：${priority[task.priority] ?? task.priority}`,
      `- 指派：${task.assignee_agent ?? '未指派'}${task.owner_required ? '（需要主人亲手确认）' : ''}`,
      `- 截止：${task.due_at ?? '未设置'} · 进度：${task.progress ?? 0}%`,
      '',
      '## 任务规划',
      task.plan ? task.plan : '（还没写，先补一段可执行的步骤再动手。）',
      '',
      '## 子任务',
      subtasks.length
        ? subtasks.map((s) => `- [${s.status === 'completed' ? 'x' : ' '}] ${s.title}${s.assignee_agent ? ` · ${s.assignee_agent}` : ''}`).join('\n')
        : '（无）',
      '',
      '## 项目上下文',
      `- 项目：${project.name}（阶段 ${project.stage} / 状态 ${project.status} / 进度 ${project.progress}%）`,
      `- 项目目的：${project.purpose || '未填写'}`,
      `- 项目规划：${project.plan || '未填写'}`,
      `- 项目综述：${project.summary || '未填写'}`,
      `- 同期任务：${siblings.filter((s) => s.id !== task.id).map((s) => `${s.title}(${label[s.status] ?? s.status})`).join('、') || '无'}`,
      milestones.length
        ? `- 里程碑：${milestones.map((m) => `${m.due_at} ${m.title}${m.done_at ? ' ✓' : ''}`).join('；')}`
        : '- 里程碑：无',
      '',
      '## 回传（必做）',
      `1. 推进了：POST ${base}/api/workbench/report，body {"project":"${project.name}","kind":"progress","summary":"一句话","outcome":"advanced","percent":<0-100>}`,
      `2. 完成这条任务：PATCH ${base}/api/studio/tasks?id=${task.id}，body {"status":"completed"}`,
      `3. 卡住或需要主人检查：POST ${base}/api/studio/check，body {"task_id":"${task.id}","reason":"卡在哪"}`,
      `4. token 记账：POST ${base}/api/workbench/tokens，{ "project":"${project.name}", "tokens_in":n, "tokens_out":n, "waste_tokens":n, "waste_reason":"仅当 >0" }`,
      '',
      '不要改任务的状态之外的项目字段；阶段和变现口径由制定层决定。所有回传都用 `Authorization: Bearer <你的 bridge 令牌>`。',
    ].join('\n');

    return json(res, 200, {
      taskId: task.id,
      projectId: project.id,
      productId: project.product_id ?? null,
      task,
      prompt,
      contract: {
        report: `${base}/api/workbench/report`,
        tokens: `${base}/api/workbench/tokens`,
        complete: `${base}/api/studio/tasks?id=${task.id}`,
        check: `${base}/api/studio/check`,
      },
    });
  } catch (error) {
    return json(res, 503, { error: '任务摘要生成失败。', detail: String((error as Error)?.message ?? error) });
  }
}
