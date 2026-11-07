import type { VercelRequest, VercelResponse } from '@vercel/node';
import { agentForToken, db, env, json, validText } from '../_lib';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const agent = agentForToken(req);
    if (!agent) return json(res, 401, { error: 'Invalid agent token.' });

    if (req.method === 'POST') {
      if (agent !== 'grokbot') return json(res, 403, { error: 'Only Grokbot can submit work to agents.' });
      const { title, body, assigned_to } = req.body ?? {};
      if (!validText(title, 180) || !validText(body)) return json(res, 400, { error: 'Provide a title and task text.' });
      const assignee = assigned_to === undefined || assigned_to === null ? 'codex' : assigned_to;
      if (assignee !== 'codex' && assignee !== 'dev2') {
        return json(res, 400, { error: "assigned_to must be 'codex' or 'dev2'." });
      }
      const created = await db('tasks?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ owner_id: env('CONSOLE_OWNER_ID'), created_by: 'grokbot', title: title.trim(), body: body.trim(), assigned_to: assignee }),
      });
      const rows = await created.json();
      if (!created.ok) return json(res, 502, { error: `Could not queue task for ${assignee}.` });
      const task = rows[0];
      const message = await db('messages', {
        method: 'POST',
        body: JSON.stringify({ task_id: task.id, sender: 'grokbot', body: body.trim() }),
      });
      if (!message.ok) return json(res, 502, { error: 'Task queued, but its opening message was not saved.' });
      return json(res, 201, { id: task.id, status: task.status, assigned_to: task.assigned_to });
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    if (agent !== 'codex' && agent !== 'dev2' && agent !== 'grokbot') return json(res, 403, { error: 'Invalid agent.' });
    const requested = typeof req.query.agent === 'string' ? req.query.agent : '';
    if (requested !== agent) return json(res, 403, { error: 'This token is not assigned to that agent.' });

    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : '';
    if (taskId) {
      if (!/^[0-9a-f-]{36}$/i.test(taskId)) return json(res, 400, { error: 'Invalid task id.' });
      const lookup = await db(`tasks?id=eq.${taskId}&select=id,title,body,assigned_to,status,created_by,created_at,updated_at&limit=1`);
      const rows = await lookup.json();
      const task = rows[0];
      const mayRead = task && (task.assigned_to === agent || (agent === 'grokbot' && task.created_by === 'grokbot'));
      if (!lookup.ok || !mayRead) return json(res, 404, { error: 'Task not found.' });
      const messageResponse = await db(`messages?task_id=eq.${taskId}&select=sender,body,created_at&order=created_at.asc&limit=200`);
      if (!messageResponse.ok) return json(res, 502, { error: 'Could not load task messages.' });
      return json(res, 200, { task, messages: await messageResponse.json() });
    }

    const response = await db(`tasks?status=eq.pending&assigned_to=eq.${agent}&select=id,title,body,assigned_to,status,created_at&order=created_at.asc&limit=20`);
    return json(res, response.status, await response.json());
  } catch {
    return json(res, 503, { error: 'Agent queue is not configured.' });
  }
}
