import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, readJson } from '../server/lib';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const owner = await getOwner(req);
    if (!owner) return json(res, 401, { error: 'Sign in required.' });
    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : '';
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) return json(res, 400, { error: 'Invalid task id.' });
    const owns = await db(`tasks?id=eq.${taskId}&owner_id=eq.${owner}&select=id&limit=1`);
    const ownedRows = await readJson(owns);
    if (!owns.ok || !ownedRows.length) return json(res, 404, { error: 'Task not found.' });
    const response = await db(`messages?task_id=eq.${taskId}&select=*&order=created_at.asc&limit=200`);
    return json(res, response.status, await readJson(response));
  } catch {
    return json(res, 503, { error: 'Console service is not configured.' });
  }
}
