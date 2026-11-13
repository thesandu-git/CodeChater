import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson } from '../lib';
import { intIn, optionalText, parseDay, today, uuidOrNull, wbAgent } from './_shared';

function money(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'POST') {
      const agent = await wbAgent(req);
      if (!agent) return json(res, 401, { error: 'Invalid agent token.' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const day = parseDay(body.day) ?? today();
      const tokensIn = money(body.tokens_in, 'tokens_in');
      const tokensOut = money(body.tokens_out, 'tokens_out');
      const waste = money(body.waste_tokens, 'waste_tokens');
      if (tokensIn === null || tokensOut === null || waste === null) {
        return json(res, 400, { error: 'Token counts must be positive integers.' });
      }
      const reason = optionalText(body.waste_reason, 240);
      if (reason === undefined) return json(res, 400, { error: 'waste_reason is too long.' });
      if (waste > 0 && !reason) {
        return json(res, 400, { error: 'waste_reason is required when waste_tokens is above zero.' });
      }
      if (waste > tokensIn + tokensOut) {
        return json(res, 400, { error: 'waste_tokens cannot exceed the day total.' });
      }

      let projectId: string | null | undefined = uuidOrNull(body.project_id);
      if (projectId === undefined) return json(res, 400, { error: 'Invalid project id.' });
      if (!projectId && typeof body.project === 'string' && body.project.trim()) {
        const lookup = await db(`wb_projects?name=ilike.${encodeURIComponent(body.project.trim())}&select=id&limit=1`);
        const rows = await readJson(lookup);
        projectId = Array.isArray(rows) && rows[0] ? rows[0].id : null;
        if (!projectId) return json(res, 404, { error: `Project not found: ${body.project}` });
      }

      const sessions = body.sessions === undefined || body.sessions === null
        ? null
        : intIn(body.sessions, 0, 10000);
      if (body.sessions !== undefined && body.sessions !== null && sessions === null) {
        return json(res, 400, { error: 'sessions must be a whole number.' });
      }

      const written = await db('wb_token_usage?on_conflict=agent,day,project_key&select=*', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          agent,
          day,
          project_id: projectId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          waste_tokens: waste,
          waste_reason: reason ?? null,
          model: optionalText(body.model, 80) ?? null,
          sessions,
          note: optionalText(body.note, 500) ?? null,
          updated_at: new Date().toISOString(),
        }),
      });
      const rows = await readJson(written);
      if (!written.ok) return json(res, 400, { error: 'Could not save token usage.', detail: rows });
      return json(res, 201, rows[0]);
    }

    if (req.method === 'GET') {
      const owner = await getOwner(req);
      if (!owner) return json(res, 401, { error: 'Sign in required.' });
      const day = parseDay(req.query.day);
      const filter = day ? `day=eq.${day}` : `day=gte.${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}`;
      const response = await db(`wb_token_usage?select=*&${filter}&order=day.desc,agent.asc&limit=500`);
      return json(res, response.status, await readJson(response));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
