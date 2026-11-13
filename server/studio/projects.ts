import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import {
  PROJECT_STATUSES, STAGES, json, num, oneOf, requireIdentity, text, uuid,
} from './_shared';

const PRIORITIES = ['high', 'medium', 'low'] as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const status = oneOf(req.query.status, PROJECT_STATUSES);
      const product = uuid(req.query.product);
      if (product === undefined) return json(res, 400, { error: '产品 id 无效。' });
      const filters = [status ? `status=eq.${status}` : 'status=neq.killed', product ? `product_id=eq.${product}` : '']
        .filter(Boolean).join('&');
      const response = await db(`wb_studio_projects?select=*&${filters}&limit=400`);
      return json(res, response.status, await readJson(response));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) {
        return json(res, 400, { error: '项目名必填（≤180 字）。' });
      }
      const stage = oneOf(body.stage, STAGES) ?? 'idea';
      const status = oneOf(body.status, PROJECT_STATUSES) ?? 'active';
      const planId = uuid(body.plan_id);
      const productId = uuid(body.product_id);
      if (planId === undefined) return json(res, 400, { error: '预案 id 无效。' });
      if (productId === undefined) return json(res, 400, { error: '产品 id 无效。' });
      const summary = text(body.summary, 6000);
      if (summary === undefined) return json(res, 400, { error: '项目简介太长。' });

      const row: Record<string, unknown> = {
        name: body.name.trim(),
        stage,
        status,
        plan_id: planId,
        product_id: productId,
        category: text(body.category, 80) ?? null,
        purpose: text(body.purpose, 4000) ?? '',
        plan: text(body.plan, 8000) ?? '',
        progress: num(body.progress, 0, 100) ?? 0,
        priority: oneOf(body.priority, PRIORITIES) ?? 'medium',
        owner_agent: text(body.owner_agent, 32) ?? null,
        repo_url: text(body.repo_url, 500) ?? null,
        preview_url: text(body.preview_url, 500) ?? null,
        monetization_model: text(body.monetization_model, 240) ?? null,
        currency: text(body.currency, 8) ?? 'LKR',
        summary: summary ?? '',
        blocked_reason: text(body.blocked_reason, 240) ?? null,
        blocker_owner: text(body.blocker_owner, 120) ?? null,
        target_launch_at: text(body.target_launch_at, 10) ?? null,
      };

      const created = await db('wb_projects?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const createdRows = await readJson<Record<string, any>[]>(created);
      if (!created.ok) {
        const duplicate = Array.isArray(createdRows) && createdRows[0]?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? '同名项目已存在。' : '无法创建项目。',
          detail: createdRows,
        });
      }
      const project = createdRows[0];

      await db('wb_stage_events', {
        method: 'POST',
        body: JSON.stringify({ project_id: project.id, from_stage: null, to_stage: stage, actor_agent: project.owner_agent }),
      });
      if (planId) {
        await db(`wb_product_plans?id=eq.${planId}`, {
          method: 'PATCH',
          body: JSON.stringify({ project_id: project.id, status: 'converted', decided_at: new Date().toISOString() }),
        });
      }
      return json(res, 201, project);
    }

    if (req.method === 'PATCH') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要项目 id。' });

      const currentRes = await db(`wb_projects?id=eq.${id}&select=*&limit=1`);
      const currentRows = await readJson<Record<string, any>[]>(currentRes);
      const project = Array.isArray(currentRows) ? currentRows[0] : null;
      if (!currentRes.ok || !project) return json(res, 404, { error: '项目不存在。' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      let movedStage = false;
      let touchedProgress = false;

      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) {
          return json(res, 400, { error: '项目名必填（≤180 字）。' });
        }
        patch.name = body.name.trim();
      }
      if (body.stage !== undefined) {
        const stage = oneOf(body.stage, STAGES);
        if (!stage) return json(res, 400, { error: '未知阶段。' });
        if (stage !== project.stage) {
          patch.stage = stage;
          patch.stage_entered_at = new Date().toISOString();
          patch.last_progress_at = new Date().toISOString();
          movedStage = true;
          if (stage === 'revenue') patch.monetized_at = project.monetized_at ?? new Date().toISOString();
        }
      }
      if (body.status !== undefined) {
        const status = oneOf(body.status, PROJECT_STATUSES);
        if (!status) return json(res, 400, { error: '未知状态。' });
        patch.status = status;
        if (status !== 'blocked') patch.blocked_reason = null;
        if (status === 'done') patch.progress = 100;
        touchedProgress = true;
      }
      if (body.blocked_reason !== undefined) {
        const value = text(body.blocked_reason, 240);
        if (value === undefined) return json(res, 400, { error: '卡点说明太长。' });
        patch.blocked_reason = value;
      }
      if (body.blocker_owner !== undefined) {
        const value = text(body.blocker_owner, 120);
        if (value === undefined) return json(res, 400, { error: '卡点负责人太长。' });
        patch.blocker_owner = value;
      }
      for (const [field, max] of [
        ['repo_url', 500], ['preview_url', 500], ['monetization_model', 240],
        ['currency', 8], ['summary', 6000], ['owner_agent', 32], ['target_launch_at', 10],
        ['category', 80], ['purpose', 4000], ['plan', 8000],
      ] as const) {
        if (body[field] === undefined) continue;
        const value = text(body[field], max);
        if (value === undefined) return json(res, 400, { error: `${field} 太长。` });
        patch[field] = value ?? '';
      }
      if (body.product_id !== undefined) {
        const productId = uuid(body.product_id);
        if (productId === undefined) return json(res, 400, { error: '产品 id 无效。' });
        patch.product_id = productId;
      }
      if (body.priority !== undefined) {
        const priority = oneOf(body.priority, PRIORITIES);
        if (!priority) return json(res, 400, { error: '未知优先级。' });
        patch.priority = priority;
      }
      if (body.progress !== undefined) {
        const progress = num(body.progress, 0, 100);
        if (progress === null) return json(res, 400, { error: '进度必须是 0–100。' });
        patch.progress = Math.round(progress);
        touchedProgress = true;
      }
      if (body.monthly_revenue !== undefined) {
        const revenue = Number(body.monthly_revenue);
        if (!Number.isFinite(revenue) || revenue < 0) return json(res, 400, { error: '收入必须 ≥ 0。' });
        patch.monthly_revenue = revenue;
      }
      if (body.progress_note || touchedProgress) patch.last_progress_at = new Date().toISOString();

      const updated = await db(`wb_projects?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson<Record<string, any>[]>(updated);
      if (!updated.ok) {
        const duplicate = Array.isArray(rows) && rows[0]?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? '同名项目已存在。' : '无法更新项目。',
          detail: rows,
        });
      }
      if (movedStage) {
        await db('wb_stage_events', {
          method: 'POST',
          body: JSON.stringify({
            project_id: id,
            from_stage: project.stage,
            to_stage: patch.stage,
            actor_agent: who.role === 'agent' ? who.id : rows[0]?.owner_agent ?? null,
            note: text(body.progress_note, 240) ?? null,
          }),
        });
      }
      return json(res, 200, rows[0]);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '项目接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
