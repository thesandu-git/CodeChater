import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getOwner, json, readJson } from '../_lib';
import { parseDay, rpc, today } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const owner = await getOwner(req);
    if (!owner) return json(res, 401, { error: 'Sign in required.' });

    const day = parseDay(req.query.day) ?? today();
    const response = await rpc('wb_overview', { p_day: day });
    const data = await readJson(response);
    if (!response.ok) return json(res, 502, { error: 'Could not load the workbench overview.' });
    return json(res, 200, data ?? {});
  } catch {
    return json(res, 503, { error: 'Workbench is not configured.' });
  }
}
