import type { VercelRequest } from '@vercel/node';
import { createHash } from 'node:crypto';
import { db, env, readJson } from './_lib';

/**
 * 身份 = Supabase 登录令牌（owner）或 bot 令牌。
 *
 * bot 令牌有两条来源，都认：
 *   1. 自助登记发的 `wbt_<id>_…` 一次性令牌（见 /api/studio/agents），库里只存 sha256
 *   2. 环境变量里的 bridge 令牌（GROKBOT_BRIDGE_TOKEN 等），给老部署留的兼容路径
 *
 * 空的、缺失的环境变量永远不会变成可匹配的密钥。
 */
export const AGENT_TOKENS: Array<[string, string]> = [
  ['grokbot', 'GROKBOT_BRIDGE_TOKEN'],
  ['codex', 'CODEX_BRIDGE_TOKEN'],
  ['dev2', 'DEV2_BRIDGE_TOKEN'],
  ['hermes', 'HERMES_BRIDGE_TOKEN'],
  ['openbot', 'OPENBOT_BRIDGE_TOKEN'],
];

/** 令牌只存哈希：登记时返回明文一次，之后不可取回。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * 令牌 → bot 的查库结果**不缓存**：换令牌、下线必须“立刻”生效。
 * 之前缓存 60 秒，结果是换发令牌后旧令牌还能再用一分钟——线上就是这么复现的。
 * 多实例部署下进程内缓存也不可能被别的实例清掉，所以干脆不缓存；
 * 按 token_sha256 的索引查询很便宜，正确性优先。
 */
const LAST_SEEN_WRITE = new Map<string, number>();
const LAST_SEEN_WRITE_MS = 60_000;

/** last_used_at 只是观测信息：同一 bot 每分钟最多写一次，别让每次读都带一次写。 */
function touchLastUsed(agent: string): void {
  const now = Date.now();
  const last = LAST_SEEN_WRITE.get(agent);
  if (last && now - last < LAST_SEEN_WRITE_MS) return;
  LAST_SEEN_WRITE.set(agent, now);
  void db(`wb_agent_tokens?agent_id=eq.${encodeURIComponent(agent)}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => undefined);
}

async function agentForDbToken(token: string): Promise<string | null> {
  const hash = hashToken(token);
  let agent: string | null = null;
  try {
    const response = await db(`wb_agent_tokens?token_sha256=eq.${hash}&revoked=eq.false&select=agent_id&limit=1`);
    const rows = await readJson<Array<{ agent_id?: string }>>(response);
    agent = Array.isArray(rows) && rows[0]?.agent_id ? rows[0].agent_id : null;
    if (agent) touchLastUsed(agent);
  } catch {
    agent = null;
  }
  return agent;
}

/** 返回这个请求代表哪个 bot；不是 bot 就 null（owner JWT 也返回 null）。 */
export async function wbAgent(req: VercelRequest): Promise<string | null> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  for (const [agent, name] of AGENT_TOKENS) {
    let secret = '';
    try {
      secret = env(name);
    } catch {
      continue;
    }
    if (secret && token === secret) return agent;
  }
  // owner 的 Supabase JWT 是三段式，不会在令牌表里，省一次查库
  if (token.split('.').length === 3) return null;
  return agentForDbToken(token);
}
