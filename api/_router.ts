import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from './_lib';

/**
 * Vercel Hobby 每次部署最多 12 个 serverless 函数，所以 /api/studio/* 用一个
 * catch-all 函数（api/studio/[...path].ts）转发到 api/_studio/ 里的实现。
 * 路由表是静态 import 的，打包时能被追踪到；不要改成按字符串动态 import。
 */

export type Handler = (req: VercelRequest, res: VercelResponse) => unknown;

export function segments(req: VercelRequest): string[] {
  const raw = (req.query as Record<string, unknown>).path;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string' && raw) return raw.split('/').filter(Boolean);
  // 本地 harness 没设 query.path 时，从 url 里取：/api/studio/tasks → ['tasks']
  const url = String(req.url || '').split('?')[0];
  return url.split('/').filter(Boolean).slice(2);
}

export function makeRouter(name: string, routes: Record<string, Handler>) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    const seg = segments(req);
    const key = (seg[0] || '').toLowerCase();
    const route = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : undefined;
    if (typeof route !== 'function') {
      return json(res, 404, {
        error: `没有这个接口：/api/${name}/${key || ''}`.trim(),
        hint: 'GET /api/studio/manifest 看可用接口清单；手册在 /api-docs。',
      });
    }
    return route(req, res);
  };
}
