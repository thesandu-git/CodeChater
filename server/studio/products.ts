import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../lib';
import { json, num, oneOf, requireIdentity, text, uuid } from './_shared';

const STATUSES = ['active', 'paused', 'done', 'killed'] as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  try {
    if (req.method === 'GET') {
      const response = await db('wb_products?select=*&order=created_at.asc&limit=500');
      return json(res, response.status, await readJson(response));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) {
        return json(res, 400, { error: '产品名必填（≤180 字）。' });
      }
      const summary = text(body.summary, 8000);
      const plan = text(body.plan, 8000);
      const research = text(body.research, 12000);
      if (summary === undefined || plan === undefined || research === undefined) {
        return json(res, 400, { error: '综述/规划/调研超出长度限制。' });
      }
      const row: Record<string, unknown> = {
        name: body.name.trim(),
        slug: text(body.slug, 80) ?? null,
        summary: summary ?? '',
        plan: plan ?? '',
        research: research ?? '',
        target_user: text(body.target_user, 240) ?? null,
        monetization_model: text(body.monetization_model, 240) ?? null,
        currency: text(body.currency, 8) ?? 'LKR',
        status: oneOf(body.status, STATUSES) ?? 'active',
        owner_agent: text(body.owner_agent, 32) ?? null,
        target_monetized_at: text(body.target_monetized_at, 10) ?? null,
        price_hypothesis: body.price_hypothesis === undefined || body.price_hypothesis === ''
          ? null
          : num(body.price_hypothesis, 0, 1e9),
      };
      if (row.price_hypothesis === null && body.price_hypothesis !== undefined && body.price_hypothesis !== '') {
        return json(res, 400, { error: '价格假设必须 ≥ 0。' });
      }
      const response = await db('wb_products?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const data = await readJson<Record<string, unknown>[]>(response);
      if (!response.ok) {
        const duplicate = Array.isArray(data) && (data[0] as any)?.code === '23505';
        return json(res, duplicate ? 409 : 400, {
          error: duplicate ? '同名产品已存在。' : '无法创建产品。', detail: data,
        });
      }
      return json(res, 201, data[0]);
    }

    if (req.method === 'PATCH') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: '需要产品 id。' });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const texts: Array<[string, number]> = [
        ['name', 180], ['slug', 80], ['summary', 8000], ['plan', 8000], ['research', 12000],
        ['target_user', 240], ['monetization_model', 240], ['currency', 8],
        ['owner_agent', 32], ['target_monetized_at', 10],
      ];
      for (const [field, max] of texts) {
        if (body[field] === undefined) continue;
        const value = text(body[field], max);
        if (value === undefined) return json(res, 400, { error: `${field} 太长。` });
        patch[field] = field === 'name' ? (value ?? '') : value;
      }
      if (patch.name !== undefined && !String(patch.name)) return json(res, 400, { error: '产品名不能为空。' });
      if (body.status !== undefined) {
        const status = oneOf(body.status, STATUSES);
        if (!status) return json(res, 400, { error: '未知的产品状态。' });
        patch.status = status;
      }
      if (body.price_hypothesis !== undefined) {
        patch.price_hypothesis = body.price_hypothesis === '' ? null : num(body.price_hypothesis, 0, 1e9);
        if (patch.price_hypothesis === null && body.price_hypothesis !== '') return json(res, 400, { error: '价格假设必须 ≥ 0。' });
      }
      const response = await db(`wb_products?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return json(res, response.status, await readJson(response));
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '产品接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
