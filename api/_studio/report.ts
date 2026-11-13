import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson, validText } from '../_lib';
import {
  OUTCOMES,
  REPORT_KINDS,
  intIn,
  oneOf,
  optionalText,
  parseDay,
  today,
  uuidOrNull,
} from './_shared';
import { wbAgent } from '../_identity';

/** Resolve a project by uuid or exact name so a bot can report without ids. */
async function resolveProject(value: unknown): Promise<{ id: string; name: string; stage: string; status: string; blocked_reason: string | null } | null | 'invalid'> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const text = value.trim();
  if (!text) return null;

  const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  if (looksLikeId) {
    const response = await db(`wb_projects?id=eq.${text}&select=id,name,stage,status,blocked_reason&limit=1`);
    const rows = await readJson<any[]>(response);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }
  if (text.length > 180) return 'invalid';
  const byName = await db(`wb_projects?name=ilike.${encodeURIComponent(text)}&select=id,name,stage,status,blocked_reason&limit=1`);
  const rows = await readJson<any[]>(byName);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'POST') {
      const agent = await wbAgent(req);
      if (!agent) return json(res, 401, { error: 'Invalid agent token.' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!validText(body.summary, 500)) return json(res, 400, { error: 'A summary (1-500 chars) is required.' });
      const kind = oneOf(body.kind, REPORT_KINDS) ?? 'progress';
      const outcome = oneOf(body.outcome, OUTCOMES)
        ?? (kind === 'blocker' ? 'unchanged' : 'advanced');
      const percent = body.percent === undefined || body.percent === null ? null : intIn(body.percent, 0, 100);
      if (percent === null && body.percent !== undefined && body.percent !== null) {
        return json(res, 400, { error: 'percent must be an integer from 0 to 100.' });
      }
      const detail = optionalText(body.detail, 8000);
      if (detail === undefined) return json(res, 400, { error: 'Detail is too long.' });
      const blocked = body.blocked === true || kind === 'blocker';
      const blockedBy = optionalText(body.blocker_owner, 120);
      const tokens = body.tokens_total === undefined ? 0 : Number(body.tokens_total);
      if (!Number.isFinite(tokens) || tokens < 0) return json(res, 400, { error: 'tokens_total must be a number.' });

      const ref = body.project_id ?? body.project;
      let project: Awaited<ReturnType<typeof resolveProject>> = null;
      if (ref !== undefined && ref !== null && ref !== '') {
        project = await resolveProject(ref);
        if (project === 'invalid') return json(res, 400, { error: 'Invalid project reference.' });
        if (!project) return json(res, 404, { error: `Project not found: ${String(ref)}` });
      }

      const day = parseDay(body.day) ?? today();
      const inserted = await db('wb_reports?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          project_id: project?.id ?? null,
          agent,
          kind,
          summary: body.summary.trim(),
          detail: detail ?? '',
          percent,
          outcome,
          blocked,
          blocker_owner: blockedBy ?? null,
          tokens_total: Math.round(tokens),
          task_id: uuidOrNull(body.task_id) ?? null,
          source: optionalText(body.source, 40) ?? 'api',
          day,
        }),
      });
      const rows = await readJson(inserted);
      if (!inserted.ok) return json(res, 400, { error: 'Could not record the report.', detail: rows });
      const report = rows[0];

      if (project) {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (outcome === 'advanced') patch.last_progress_at = new Date().toISOString();
        if (blocked) {
          patch.status = 'blocked';
          patch.blocked_reason = body.summary.trim().slice(0, 240);
          if (blockedBy) patch.blocker_owner = blockedBy;
        } else if (outcome === 'advanced' && project.status === 'blocked') {
          patch.status = 'active';
          patch.blocked_reason = null;
          patch.blocker_owner = null;
        }
        await db(`wb_projects?id=eq.${project.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      }

      return json(res, 201, {
        id: report.id,
        agent,
        day,
        outcome,
        blocked,
        project: project ? { id: project.id, name: project.name, stage: project.stage } : null,
      });
    }

    if (req.method === 'GET') {
      const owner = await getOwner(req);
      if (!owner) return json(res, 401, { error: 'Sign in required.' });
      const day = parseDay(req.query.day);
      const projectId = uuidOrNull(req.query.project_id);
      const agent = optionalText(req.query.agent, 32);
      const limit = intIn(req.query.limit ?? 60, 1, 200) ?? 60;
      const filters = [
        day ? `day=eq.${day}` : '',
        projectId ? `project_id=eq.${projectId}` : '',
        agent ? `agent=eq.${agent}` : '',
      ].filter(Boolean);
      const query = filters.length ? `&${filters.join('&')}` : '';
      const response = await db(`wb_reports?select=*${query}&order=created_at.desc&limit=${limit}`);
      return json(res, response.status, await readJson(response));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Studio is not configured.' });
  }
}
