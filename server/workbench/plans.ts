import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson, validText } from '../lib';
import { PLAN_STATUSES, oneOf, optionalText, uuidOrNull } from './_shared';

const SELECT = 'select=*';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const owner = await getOwner(req);
    if (!owner) return json(res, 401, { error: 'Sign in required.' });

    if (req.method === 'GET') {
      const status = oneOf(req.query.status, PLAN_STATUSES);
      const filter = status ? `&status=eq.${status}` : '&status=neq.archived';
      const response = await db(`wb_product_plans?${SELECT}${filter}&order=proposed_at.desc&limit=200`);
      return json(res, response.status, await readJson(response));
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = body.title;
      if (!validText(title, 180)) return json(res, 400, { error: 'A plan title is required.' });
      const summary = optionalText(body.summary, 6000);
      const notes = optionalText(body.notes, 6000);
      const price = body.price_hypothesis === undefined || body.price_hypothesis === null || body.price_hypothesis === ''
        ? null
        : Number(body.price_hypothesis);
      if (summary === undefined || notes === undefined) return json(res, 400, { error: 'Text is too long.' });
      if (price !== null && (!Number.isFinite(price) || price < 0)) return json(res, 400, { error: 'Price must be a positive number.' });

      const row: Record<string, unknown> = {
        title: title.trim(),
        summary: summary ?? '',
        notes: notes ?? '',
        status: oneOf(body.status, PLAN_STATUSES) ?? 'draft',
        source_agent: optionalText(body.source_agent, 32) ?? null,
        proposed_by: optionalText(body.proposed_by, 120) ?? null,
        target_user: optionalText(body.target_user, 240) ?? null,
        price_hypothesis: price,
        currency: optionalText(body.currency, 8) ?? 'LKR',
      };
      const response = await db('wb_product_plans?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const rows = await readJson(response);
      if (!response.ok) return json(res, 400, { error: 'Could not save the plan.', detail: rows });
      return json(res, 201, rows[0]);
    }

    if (req.method === 'PATCH') {
      const id = uuidOrNull(req.query.id);
      if (!id) return json(res, 400, { error: 'A plan id is required.' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (body.title !== undefined) {
        if (!validText(body.title, 180)) return json(res, 400, { error: 'A plan title is required.' });
        patch.title = body.title.trim();
      }
      for (const [field, max] of [['summary', 6000], ['notes', 6000]] as const) {
        if (body[field] !== undefined) {
          const value = optionalText(body[field], max);
          if (value === undefined) return json(res, 400, { error: 'Text is too long.' });
          patch[field] = value ?? '';
        }
      }
      if (body.status !== undefined) {
        const status = oneOf(body.status, PLAN_STATUSES);
        if (!status) return json(res, 400, { error: 'Unknown plan status.' });
        patch.status = status;
        patch.decided_at = status === 'draft' ? null : new Date().toISOString();
      }
      if (body.project_id !== undefined) {
        const projectId = uuidOrNull(body.project_id);
        if (projectId === undefined) return json(res, 400, { error: 'Invalid project id.' });
        patch.project_id = projectId;
        if (projectId) patch.status = 'converted';
      }

      const response = await db(`wb_product_plans?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson(response);
      if (!response.ok) return json(res, 400, { error: 'Could not update the plan.', detail: rows });
      if (!rows.length) return json(res, 404, { error: 'Plan not found.' });
      return json(res, 200, rows[0]);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
