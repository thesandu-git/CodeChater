import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import { json, requireIdentity, text, uuid } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const project = uuid(req.query.project);
      if (project === undefined) return json(res, 400, { error: '项目 id 无效。' });
      const filter = project ? `&project_id=eq.${project}` : '';
      const response = await db(`wb_milestones?select=*&order=due_at.asc&limit=500${filter}`);
      return json(res, response.status, await readJson(response));
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST') {
      const projectId = uuid(body.project_id);
      if (!projectId) return json(res, 400, { error: '里程碑必须挂在项目上。' });
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
        return json(res, 400, { error: '里程碑标题必填（≤200 字）。' });
      }
      const due = text(body.due_at, 10);
      if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json(res, 400, { error: 'due_at 必须是 YYYY-MM-DD。' });
      const row = {
        project_id: projectId,
        title: body.title.trim(),
        due_at: due,
        done_at: text(body.done_at, 10) ?? null,
        owner_required: Boolean(body.owner_required),
        note: text(body.note, 400) ?? null,
      };
      const created = await db('wb_milestones?select=*', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
      });
      return json(res, created.status, await readJson(created));
    }

    if (req.method === 'PATCH') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要里程碑 id。' });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [field, max] of [['title', 200], ['note', 400], ['due_at', 10], ['done_at', 10]] as const) {
        if (body[field] === undefined) continue;
        const value = text(body[field], max);
        if (value === undefined) return json(res, 400, { error: `${field} 无效。` });
        patch[field] = value;
      }
      if (body.owner_required !== undefined) patch.owner_required = Boolean(body.owner_required);
      const updated = await db(`wb_milestones?id=eq.${id}&select=*`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      return json(res, updated.status, await readJson(updated));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '里程碑接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
