import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson, validText } from '../_lib';
import { optionalText } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const owner = await getOwner(req);
    if (!owner) return json(res, 401, { error: 'Sign in required.' });

    if (req.method === 'GET') {
      const response = await db('wb_agents?select=*&order=id.asc');
      return json(res, response.status, await readJson(response));
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
      if (!/^[a-z0-9_-]{2,32}$/.test(id)) return json(res, 400, { error: 'Agent id must be 2-32 lowercase characters.' });
      if (!validText(body.display_name, 80)) return json(res, 400, { error: 'A display name is required.' });
      const kind = body.kind === 'human' ? 'human' : 'bot';
      const response = await db('wb_agents?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          id,
          display_name: body.display_name.trim(),
          kind,
          platform: optionalText(body.platform, 80) ?? null,
          role: optionalText(body.role, 160) ?? null,
        }),
      });
      const rows = await readJson(response);
      if (!response.ok) {
        const duplicate = Array.isArray(rows) && rows[0]?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? 'That agent already exists.' : 'Could not add the agent.',
          detail: rows,
        });
      }
      return json(res, 201, rows[0]);
    }

    if (req.method === 'PATCH') {
      const key = typeof req.query.id === 'string' ? req.query.id.trim() : '';
      if (!key) return json(res, 400, { error: 'An agent id is required.' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (body.display_name !== undefined) {
        if (!validText(body.display_name, 80)) return json(res, 400, { error: 'A display name is required.' });
        patch.display_name = body.display_name.trim();
      }
      if (body.role !== undefined) patch.role = optionalText(body.role, 160);
      if (body.platform !== undefined) patch.platform = optionalText(body.platform, 80);
      if (body.active !== undefined) patch.active = body.active === true;
      if (!Object.keys(patch).length) return json(res, 400, { error: 'Nothing to update.' });
      const response = await db(`wb_agents?id=eq.${encodeURIComponent(key)}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson(response);
      if (!response.ok) return json(res, 400, { error: 'Could not update the agent.', detail: rows });
      if (!rows.length) return json(res, 404, { error: 'Agent not found.' });
      return json(res, 200, rows[0]);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
