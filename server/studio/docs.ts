import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import { DOC_KINDS, json, oneOf, requireIdentity, text, uuid } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const project = uuid(req.query.project);
      const product = uuid(req.query.product);
      if (project === undefined || product === undefined) return json(res, 400, { error: 'id 无效。' });
      const filters = [project ? `project_id=eq.${project}` : '', product ? `product_id=eq.${product}` : '']
        .filter(Boolean).join('&');
      const response = await db(`wb_docs?select=*&${filters ? `${filters}&` : ''}order=created_at.desc&limit=200`);
      return json(res, response.status, await readJson(response));
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 240) {
        return json(res, 400, { error: '文档标题必填（≤240 字）。' });
      }
      const projectId = uuid(body.project_id);
      const productId = uuid(body.product_id);
      if (projectId === undefined || productId === undefined) return json(res, 400, { error: 'id 无效。' });
      if (!projectId && !productId) return json(res, 400, { error: '研究文档要挂在项目或产品上。' });
      const row = {
        project_id: projectId,
        product_id: productId,
        title: body.title.trim(),
        kind: oneOf(body.kind, DOC_KINDS) ?? 'research',
        url: text(body.url, 800) ?? null,
        body: text(body.body, 20000) ?? '',
        agent: text(body.agent, 32) ?? (who.role === 'agent' ? who.id : null),
      };
      const created = await db('wb_docs?select=*', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
      });
      return json(res, created.status, await readJson(created));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '文档接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
