import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../_lib';
import {
  SCHEDULE_KINDS, addDays, dayStartIso, json, oneOf, parseDay, requireIdentity, text, today, uuid,
} from './_shared';

/** 只给日期时按科伦坡上午 9 点落库，保证日历归到那一天。 */
function toIso(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T09:00:00+05:30`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const anchor = parseDay(req.query.day) ?? today();
      const from = dayStartIso(parseDay(req.query.from) ?? addDays(anchor, -31));
      const to = dayStartIso(addDays(parseDay(req.query.to) ?? addDays(anchor, 61), 1));
      const response = await db(
        `wb_schedule?select=*&start_at=gte.${encodeURIComponent(from)}&start_at=lt.${encodeURIComponent(to)}&order=start_at.asc&limit=2000`,
      );
      return json(res, response.status, await readJson(response));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST') {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
        return json(res, 400, { error: '日程标题必填（≤200 字）。' });
      }
      const start = toIso(body.start_at ?? body.day);
      if (!start) return json(res, 400, { error: '需要开始时间（start_at 或 day=YYYY-MM-DD）。' });
      const end = toIso(body.end_at);
      if (end === undefined) return json(res, 400, { error: '结束时间无效。' });
      const projectId = uuid(body.project_id);
      const productId = uuid(body.product_id);
      if (projectId === undefined) return json(res, 400, { error: '项目 id 无效。' });
      if (productId === undefined) return json(res, 400, { error: '产品 id 无效。' });

      const row: Record<string, unknown> = {
        title: body.title.trim(),
        detail: text(body.detail, 4000) ?? '',
        project_id: projectId,
        product_id: productId,
        kind: oneOf(body.kind, SCHEDULE_KINDS) ?? 'work',
        owner_required: Boolean(body.owner_required) || oneOf(body.kind, SCHEDULE_KINDS) === 'owner',
        start_at: start,
        end_at: end,
        agent: text(body.agent, 32) ?? (who.role === 'agent' ? who.id : null),
        done: Boolean(body.done),
        done_at: body.done ? new Date().toISOString() : null,
      };
      const created = await db('wb_schedule?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const rows = await readJson<Record<string, any>[]>(created);
      if (!created.ok) return json(res, 400, { error: '无法创建日程。', detail: rows });
      return json(res, 201, rows[0]);
    }

    if (req.method === 'PATCH') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要日程 id。' });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
          return json(res, 400, { error: '日程标题必填（≤200 字）。' });
        }
        patch.title = body.title.trim();
      }
      if (body.detail !== undefined) {
        const value = text(body.detail, 4000);
        if (value === undefined) return json(res, 400, { error: '说明太长。' });
        patch.detail = value ?? '';
      }
      if (body.kind !== undefined) {
        const kind = oneOf(body.kind, SCHEDULE_KINDS);
        if (!kind) return json(res, 400, { error: '未知日程类型。' });
        patch.kind = kind;
      }
      if (body.owner_required !== undefined) patch.owner_required = Boolean(body.owner_required);
      if (body.done !== undefined) {
        patch.done = Boolean(body.done);
        patch.done_at = body.done ? new Date().toISOString() : null;
      }
      const start = body.start_at === undefined ? undefined : toIso(body.start_at);
      if (start === undefined) return json(res, 400, { error: '开始时间无效。' });
      if (start) patch.start_at = start;
      const end = body.end_at === undefined ? undefined : toIso(body.end_at);
      if (end === undefined) return json(res, 400, { error: '结束时间无效。' });
      if (end !== undefined) patch.end_at = end;
      if (body.project_id !== undefined) {
        const projectId = uuid(body.project_id);
        if (projectId === undefined) return json(res, 400, { error: '项目 id 无效。' });
        patch.project_id = projectId;
      }
      const updated = await db(`wb_schedule?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return json(res, updated.status, await readJson(updated));
    }

    if (req.method === 'DELETE') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要日程 id。' });
      const deleted = await db(`wb_schedule?id=eq.${id}`, { method: 'DELETE' });
      return json(res, deleted.status === 204 ? 204 : deleted.status, null);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '日程接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
