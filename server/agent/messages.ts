import type { VercelRequest, VercelResponse } from '@vercel/node';
import { agentForToken, db, json, readJson, type TaskStatus, validText } from '../lib';

const statuses: TaskStatus[] = ['working', 'needs_input', 'done', 'failed'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const agent = agentForToken(req);
    if (!agent) return json(res, 401, { error: 'Invalid agent token.' });
    const { task_id, body, status = 'working' } = req.body ?? {};
    if (typeof task_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(task_id) || !validText(body) || !statuses.includes(status)) {
      return json(res, 400, { error: 'Provide a valid task id, message, and status.' });
    }
    const taskResponse = await db(`tasks?id=eq.${task_id}&select=id,assigned_to,created_by,status&limit=1`);
    const rows = await readJson(taskResponse);
    const task = rows[0];
    if (!taskResponse.ok || !task) return json(res, 404, { error: 'Task not found.' });
    const assignedAgent = task.assigned_to === agent;
    const taskCreatorGrok = agent === 'grokbot' && task.created_by === 'grokbot';
    if (!assignedAgent && !taskCreatorGrok) return json(res, 403, { error: 'Task is not assigned to this agent.' });
    const messageResponse = await db('messages', {
      method: 'POST',
      body: JSON.stringify({ task_id, sender: agent, body: body.trim() }),
    });
    if (!messageResponse.ok) return json(res, 502, { error: 'Could not save message.' });
    if (!assignedAgent) return json(res, 201, { saved: true, status: task.status });
    const updateResponse = await db(`tasks?id=eq.${task_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    if (!updateResponse.ok) return json(res, 502, { error: 'Message saved, but task status was not updated.' });
    return json(res, 201, { saved: true });
  } catch {
    return json(res, 503, { error: 'Agent endpoint is not configured.' });
  }
}
