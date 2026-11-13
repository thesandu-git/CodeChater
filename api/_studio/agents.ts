import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { db, readJson } from '../_lib';
import { hashToken } from '../_identity';
import { bearerToken, identify, json, num, oneOf, registryToken, text } from './_shared';

/**
 * bot 登记接口——自助接入的唯一入口。
 *
 * 两扇门：
 *   1) 已有的任一有效令牌（owner 的 Supabase JWT，或任一已登记 bot 的令牌），权限与其余接口相同；
 *   2) REGISTRY_TOKEN：只用于第一次登记，只能 POST 建新 bot，不能读、不能改、不能换别人的令牌。
 * 第二扇门解决“新 bot 没有令牌 → 不能登记 → 永远没有令牌”的死循环，且不引入任何岗位权限。
 * 登记时返回一次明文令牌，库里只存 sha256；轮换用 POST {id, rotate_token:true}
 * （PATCH ?id= 也支持 rotate_token，两条路都会把新令牌放在响应的 token 字段里）。
 */

const KINDS = ['bot', 'human', 'relay'] as const;
const ID_RE = /^[a-z0-9_-]{2,32}$/;

type Row = Record<string, any>;

function field(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value.trim() || null;
}

/** capabilities：数组或 "code, crawl" 这种逗号/空格分隔的短标签。 */
function parseCaps(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/[,，\s]+/).filter(Boolean);
  else return null;
  if (list.length > 12) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') return null;
    const tag = item.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > 40 || !/^[a-z0-9_:-]+$/.test(tag)) return null;
    out.push(tag);
  }
  return [...new Set(out)];
}

async function one(path: string): Promise<Row | null> {
  try {
    const response = await db(path);
    const rows = await readJson<Row[]>(response);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

async function issueToken(agentId: string, label: string | null): Promise<string | null> {
  const token = `wbt_${agentId}_${randomBytes(18).toString('base64url')}`;
  const response = await db('wb_agent_tokens?on_conflict=agent_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      agent_id: agentId,
      token_sha256: hashToken(token),
      label: label ?? null,
      created_at: new Date().toISOString(),
      revoked: false,
    }),
  });
  return response.ok ? token : null;
}

async function revokeToken(agentId: string): Promise<void> {
  try {
    await db(`wb_agent_tokens?agent_id=eq.${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ revoked: true }),
    });
  } catch {
    /* 撤销失败要能在响应里看出来：这里吞掉，由调用方读 revoked 字段确认 */
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await identify(req);
  const registry = !who && Boolean(registryToken()) && bearerToken(req) === registryToken();
  if (!who && !registry) {
    json(res, 401, {
      error: '需要一个令牌：已有 bot 的令牌、owner 登录，或（仅登记时）REGISTRY_TOKEN。',
      hint: '第一次接入先用引导令牌 POST 登记，拿到自己的令牌后再调其它接口。',
    });
    return;
  }
  if (!who && req.method !== 'POST') {
    return json(res, 403, {
      error: '引导令牌只能用来 POST 登记新 bot。',
      hint: '登记完立刻用返回的自己的令牌，引导令牌别再用于别的接口。',
    });
  }
  try {
    if (req.method === 'GET') {
      const id = field(req.query.id, 32);
      const kind = oneOf(req.query.kind, KINDS);
      const capability = field(req.query.capability, 40)?.toLowerCase();
      const includeInactive = req.query.all === '1' || req.query.all === 'true';
      const filters = [
        id ? `id=eq.${encodeURIComponent(id)}` : '',
        kind ? `kind=eq.${kind}` : '',
        includeInactive ? '' : 'active=eq.true',
        capability ? `capabilities=cs.{${capability}}` : '',
      ].filter(Boolean);

      const [deskRes, tokensRes] = await Promise.all([
        db(`wb_relay_desk?select=*${filters.length ? `&${filters.join('&')}` : ''}&order=kind.asc,id.asc&limit=300`),
        db('wb_agent_tokens?select=agent_id,created_at,last_used_at,revoked&limit=1000'),
      ]);
      const agents = await readJson<Row[]>(deskRes);
      const tokens = await readJson<Row[]>(tokensRes);
      if (!deskRes.ok || !Array.isArray(agents)) {
        return json(res, 503, { error: '读取登记表失败。', detail: agents });
      }
      const tokenByAgent = new Map((Array.isArray(tokens) ? tokens : []).map((t) => [t.agent_id, t]));
      const withTokens: Row[] = agents.map((a) => {
        const t = tokenByAgent.get(a.id);
        return {
          ...a,
          hasToken: Boolean(t && !t.revoked),
          tokenIssuedAt: t?.created_at ?? null,
          tokenLastUsedAt: t?.last_used_at ?? null,
        };
      });
      const online = withTokens.filter((a) => a.online).length;
      return json(res, 200, {
        agents: withTokens,
        counts: {
          total: withTokens.length,
          online,
          bots: withTokens.filter((a) => a.kind === 'bot').length,
          relays: withTokens.filter((a) => a.kind === 'relay').length,
          humans: withTokens.filter((a) => a.kind === 'human').length,
        },
        hint: '登记新 bot / 换令牌：POST /api/studio/agents {id, rotate_token:true}；心跳：PATCH /api/studio/agents?id=<id> {heartbeat:true}；待命取单：GET /api/studio/inbox?relay=<id>',
      });
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!ID_RE.test(id)) {
        return json(res, 400, { error: 'id 必填，只能用小写字母、数字、下划线和连字符，2–32 位。', example: 'prasad-crawler' });
      }
      const displayName = field(body.display_name, 80);
      if (displayName === undefined) return json(res, 400, { error: 'display_name 最多 80 字。' });
      const caps = parseCaps(body.capabilities);
      if (caps === null) return json(res, 400, { error: 'capabilities 最多 12 个标签，每个 ≤40 位，只含小写字母/数字/_/:/ -。' });
      const kind = body.kind === undefined ? 'bot' : oneOf(body.kind, KINDS);
      if (!kind) return json(res, 400, { error: 'kind 只能是 bot / human / relay。' });

      const row: Record<string, unknown> = {
        id,
        display_name: displayName ?? id,
        kind,
        platform: field(body.platform, 40) ?? null,
        role: field(body.role, 80) ?? null,
        capabilities: caps,
        contact: field(body.contact, 200) ?? null,
        endpoint: field(body.endpoint, 300) ?? null,
        relay_agent: field(body.relay_agent, 32) ?? null,
        heartbeat_s: num(body.heartbeat_s, 15, 3600) ?? 60,
        notes: field(body.notes, 1000) ?? null,
        registered_by: who?.id ?? 'registry',
        updated_at: new Date().toISOString(),
      };
      for (const key of ['platform', 'role', 'contact', 'endpoint', 'relay_agent', 'notes'] as const) {
        if (body[key] !== undefined && row[key] === null && typeof body[key] === 'string' && body[key].trim()) {
          return json(res, 400, { error: `${key} 太长。` });
        }
      }

      const before = await one(`wb_agents?id=eq.${encodeURIComponent(id)}&select=id`);
      if (registry && before) {
        return json(res, 409, {
          error: '这个 id 已经登记过。',
          hint: '换令牌要用它自己的令牌 POST /api/studio/agents {id, rotate_token:true}。',
        });
      }
      const created = await db('wb_agents?on_conflict=id&select=*', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      const rows = await readJson<Row[]>(created);
      if (!created.ok || !Array.isArray(rows) || !rows[0]) {
        return json(res, 400, { error: '无法登记 bot。', detail: rows });
      }

      const isNew = !before;
      const wantsToken = body.issue_token !== false && kind !== 'human';
      const token = (isNew || body.rotate_token === true) && wantsToken ? await issueToken(id, field(body.token_label, 60) ?? null) : null;

      return json(res, isNew ? 201 : 200, {
        agent: rows[0],
        created: isNew,
        token,
        tokenNote: token
          ? '这串令牌只显示这一次，库里只存哈希。丢了再用 POST /api/studio/agents {id, rotate_token:true} 换新的。'
          : isNew
            ? '未发令牌（issue_token=false）。'
            : '已存在，未动令牌；要换用 POST /api/studio/agents {id, rotate_token:true}。',
      });
    }

    if (req.method === 'PATCH') {
      const id = field(req.query.id, 32);
      if (!id) return json(res, 400, { error: '需要 ?id=' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = await one(`wb_agents?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
      if (!current) return json(res, 404, { error: '没有这个 bot，先 POST 登记。' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.heartbeat === true) patch.last_seen_at = new Date().toISOString();
      for (const [key, max] of [['display_name', 80], ['platform', 40], ['role', 80], ['contact', 200],
        ['endpoint', 300], ['relay_agent', 32], ['notes', 1000]] as const) {
        if (body[key] === undefined) continue;
        const value = field(body[key], max);
        if (value === undefined) return json(res, 400, { error: `${key} 太长。` });
        patch[key] = value;
      }
      if (body.kind !== undefined) {
        const kind = oneOf(body.kind, KINDS);
        if (!kind) return json(res, 400, { error: 'kind 只能是 bot / human / relay。' });
        patch.kind = kind;
      }
      if (body.capabilities !== undefined) {
        const caps = parseCaps(body.capabilities);
        if (caps === null) return json(res, 400, { error: 'capabilities 无效。' });
        patch.capabilities = caps;
      }
      if (body.heartbeat_s !== undefined) {
        const beat = num(body.heartbeat_s, 15, 3600);
        if (beat === null) return json(res, 400, { error: 'heartbeat_s 必须在 15–3600 秒。' });
        patch.heartbeat_s = Math.round(beat);
      }
      if (body.active !== undefined) patch.active = Boolean(body.active);

      const updated = await db(`wb_agents?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await readJson<Row[]>(updated);
      if (!updated.ok || !Array.isArray(rows) || !rows[0]) {
        return json(res, 400, { error: '无法更新登记。', detail: rows });
      }

      // 轮换只走一条路：拿不到新令牌就报错，绝不 200 + token:null 地静默过去。
      let token: string | null = null;
      if (body.active === false) {
        await revokeToken(id);
      } else if (body.rotate_token === true) {
        token = await issueToken(id, 'rotated');
        if (!token) {
          return json(res, 503, {
            error: '换令牌失败：新令牌没写进库，旧令牌仍然有效。',
            hint: '重试一次；或改用 POST /api/studio/agents {id, rotate_token:true}（同一条路）。',
          });
        }
      }

      return json(res, 200, {
        agent: rows[0],
        token,
        tokenNote: token ? '新令牌只显示这一次，旧令牌立刻失效。' : undefined,
      });
    }

    if (req.method === 'DELETE') {
      const id = field(req.query.id, 32);
      if (!id) return json(res, 400, { error: '需要 ?id=' });
      // 软下线：历史汇报、任务、派单都指向这个 id，不删行
      const updated = await db(`wb_agents?id=eq.${encodeURIComponent(id)}&select=id,active`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
      });
      const rows = await readJson<Row[]>(updated);
      if (!updated.ok || !Array.isArray(rows) || !rows[0]) return json(res, 404, { error: '没有这个 bot。' });
      await revokeToken(id);
      return json(res, 200, { archived: true, id, note: '已下线并吊销令牌；历史记录保留。' });
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 503, { error: '登记接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
