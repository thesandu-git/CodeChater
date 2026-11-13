import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson } from '../lib';
import { intIn, optionalText, parseDay, today, wbAgent } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'POST') {
      const agent = await wbAgent(req);
      if (!agent) return json(res, 401, { error: 'Invalid agent token.' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const log = body.log_markdown;
      if (typeof log !== 'string' || log.trim().length < 1 || log.length > 20000) {
        return json(res, 400, { error: 'log_markdown (1-20000 chars) is required.' });
      }
      const day = parseDay(body.day) ?? today();

      const usage = await db(`wb_token_usage?agent=eq.${agent}&day=eq.${day}&select=tokens_in,tokens_out,waste_tokens`);
      const usageRows = await readJson(usage);
      const measured = Array.isArray(usageRows)
        ? usageRows.reduce(
            (acc, row) => ({
              total: acc.total + (Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0),
              waste: acc.waste + (Number(row.waste_tokens) || 0),
            }),
            { total: 0, waste: 0 },
          )
        : { total: 0, waste: 0 };

      const declaredTotal = body.tokens_total === undefined ? measured.total : Number(body.tokens_total);
      const declaredWaste = body.waste_tokens === undefined ? measured.waste : Number(body.waste_tokens);
      if (!Number.isFinite(declaredTotal) || !Number.isFinite(declaredWaste)
        || declaredTotal < 0 || declaredWaste < 0) {
        return json(res, 400, { error: 'Token counts must be positive numbers.' });
      }

      const projects = Array.isArray(body.projects)
        ? body.projects.filter((value): value is string => typeof value === 'string').slice(0, 50)
        : [];
      const done = body.tasks_done === undefined || body.tasks_done === null ? null : intIn(body.tasks_done, 0, 10000);
      const failed = body.tasks_failed === undefined || body.tasks_failed === null ? null : intIn(body.tasks_failed, 0, 10000);

      const written = await db('wb_agent_logs?on_conflict=agent,day&select=*', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          agent,
          day,
          log_markdown: log,
          projects,
          tokens_total: Math.round(declaredTotal),
          waste_tokens: Math.round(declaredWaste),
          tasks_done: done,
          tasks_failed: failed,
          self_review: optionalText(body.self_review, 4000) ?? null,
          updated_at: new Date().toISOString(),
        }),
      });
      const rows = await readJson(written);
      if (!written.ok) return json(res, 400, { error: 'Could not save the agent log.', detail: rows });
      return json(res, 201, rows[0]);
    }

    if (req.method === 'GET') {
      const owner = await getOwner(req);
      if (!owner) return json(res, 401, { error: 'Sign in required.' });
      const day = parseDay(req.query.day);
      const filter = day ? `day=eq.${day}` : `day=gte.${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}`;
      const response = await db(`wb_agent_logs?select=*&${filter}&order=day.desc,agent.asc&limit=200`);
      return json(res, response.status, await readJson(response));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
