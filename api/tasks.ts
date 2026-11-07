import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, getOwner, json, validText } from './_lib';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const owner = await getOwner(req);
    if (!owner) return json(res, 401, { error: 'Sign in required.' });

    if (req.method === 'GET') {
      const response = await db(`tasks?owner_id=eq.${owner}&select=*&order=created_at.desc&limit=100`);
      return json(res, response.status, await response.json());
    }

    if (req.method === 'POST') {
      const { title, body, assigned_to } = req.body ?? {};
      if (!validText(title, 180) || !validText(body) || !['grokbot', 'codex'].includes(assigned_to)) {
        return json(res, 400, { error: 'Provide a title, task text, and a valid assignee.' });
      }
      const response = await db('tasks?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ owner_id: owner, created_by: 'owner', title: title.trim(), body: body.trim(), assigned_to }),
      });
      const rows = await response.json();
      if (!response.ok) return json(res, response.status, { error: 'Could not create task.' });
      const task = rows[0];
      const msg = await db('messages', {
        method: 'POST',
        body: JSON.stringify({ task_id: task.id, sender: 'owner', body: body.trim() }),
      });
      if (!msg.ok) return json(res, 502, { error: 'Task created but its opening message was not saved.' });
      return json(res, 201, task);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Console service is not configured.' });
  }
}
