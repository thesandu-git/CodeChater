import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson, validText } from '../_lib';
import { PROJECT_STATUSES, STAGES, oneOf, optionalText, uuidOrNull, wbAgent } from './_shared';

const BOARD_SELECT = 'select=*';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const owner = await getOwner(req);
    if (!owner) {
      // 只读例外：带 agent 令牌的 bot 可以看项目板，方便决定下一步报什么。
      const agent = req.method === 'GET' ? await wbAgent(req) : null;
      if (!agent) return json(res, 401, { error: 'Sign in required.' });
      const response = await db(
        'wb_project_board?select=id,name,stage,status,owner_agent,days_in_stage,days_since_progress,is_stuck,blocked_reason,last_report,last_report_at&status=neq.killed&limit=200',
      );
      return json(res, response.status, await readJson(response));
    }

    if (req.method === 'GET') {
      const status = oneOf(req.query.status, PROJECT_STATUSES);
      const filter = status ? `&status=eq.${status}` : '&status=neq.killed';
      const response = await db(`wb_project_board?${BOARD_SELECT}${filter}&limit=200`);
      return json(res, response.status, await readJson(response));
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!validText(body.name, 180)) return json(res, 400, { error: 'A project name is required.' });
      const stage = oneOf(body.stage, STAGES) ?? 'idea';
      const status = oneOf(body.status, PROJECT_STATUSES) ?? 'active';
      const planId = uuidOrNull(body.plan_id);
      if (planId === undefined) return json(res, 400, { error: 'Invalid plan id.' });
      const summary = optionalText(body.summary, 6000);
      if (summary === undefined) return json(res, 400, { error: 'Summary is too long.' });

      const row: Record<string, unknown> = {
        name: body.name.trim(),
        stage,
        status,
        plan_id: planId,
        owner_agent: optionalText(body.owner_agent, 32) ?? null,
        repo_url: optionalText(body.repo_url, 500) ?? null,
        preview_url: optionalText(body.preview_url, 500) ?? null,
        monetization_model: optionalText(body.monetization_model, 240) ?? null,
        currency: optionalText(body.currency, 8) ?? 'LKR',
        summary: summary ?? '',
        blocked_reason: optionalText(body.blocked_reason, 240) ?? null,
        blocker_owner: optionalText(body.blocker_owner, 120) ?? null,
        target_launch_at: optionalText(body.target_launch_at, 10) ?? null,
      };

      const created = await db('wb_projects?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const rows = await readJson(created);
      if (!created.ok) {
        const duplicate = Array.isArray(rows) && rows[0]?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? 'A project with that name already exists.' : 'Could not create the project.',
          detail: rows,
        });
      }
      const project = rows[0];

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
      const id = uuidOrNull(req.query.id);
      if (!id) return json(res, 400, { error: 'A project id is required.' });
      const body = (req.body ?? {}) as Record<string, unknown>;

      const current = await db(`wb_projects?id=eq.${id}&select=*&limit=1`);
      const currentRows = await readJson(current);
      const project = Array.isArray(currentRows) ? currentRows[0] : null;
      if (!current.ok || !project) return json(res, 404, { error: 'Project not found.' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      let movedStage = false;

      if (body.name !== undefined) {
        if (!validText(body.name, 180)) return json(res, 400, { error: 'A project name is required.' });
        patch.name = body.name.trim();
      }
      if (body.stage !== undefined) {
        const stage = oneOf(body.stage, STAGES);
        if (!stage) return json(res, 400, { error: 'Unknown stage.' });
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
        if (!status) return json(res, 400, { error: 'Unknown status.' });
        patch.status = status;
        if (status !== 'blocked') patch.blocked_reason = null;
      }
      if (body.blocked_reason !== undefined) patch.blocked_reason = optionalText(body.blocked_reason, 240) ?? null;
      if (body.blocker_owner !== undefined) patch.blocker_owner = optionalText(body.blocker_owner, 120) ?? null;
      for (const [field, max] of [
        ['repo_url', 500],
        ['preview_url', 500],
        ['monetization_model', 240],
        ['currency', 8],
        ['summary', 6000],
        ['owner_agent', 32],
        ['target_launch_at', 10],
      ] as const) {
        if (body[field] !== undefined) {
          const value = optionalText(body[field], max);
          if (value === undefined) return json(res, 400, { error: `${field} is too long.` });
          patch[field] = value;
        }
      }
      if (body.monthly_revenue !== undefined) {
        const revenue = Number(body.monthly_revenue);
        if (!Number.isFinite(revenue) || revenue < 0) return json(res, 400, { error: 'Revenue must be a number.' });
        patch.monthly_revenue = revenue;
      }
      if (body.progress_note) patch.last_progress_at = new Date().toISOString();

      const response = await db(`wb_projects?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson(response);
      if (!response.ok) {
        const duplicate = Array.isArray(rows) && rows[0]?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? 'A project with that name already exists.' : 'Could not update the project.',
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
            actor_agent: rows[0]?.owner_agent ?? null,
            note: optionalText(body.progress_note, 240) ?? null,
          }),
        });
      }
      return json(res, 200, rows[0]);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
