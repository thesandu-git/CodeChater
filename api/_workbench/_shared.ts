import type { VercelRequest } from '@vercel/node';
import { createHash } from 'node:crypto';
import { db, env, readJson } from '../_lib';

export const STAGES = ['idea', 'proposal', 'validated', 'build', 'testing', 'launch', 'revenue'] as const;
export type Stage = (typeof STAGES)[number];

export const PROJECT_STATUSES = ['active', 'blocked', 'paused', 'done', 'killed'] as const;
export const PLAN_STATUSES = ['draft', 'validated', 'approved', 'rejected', 'converted', 'archived'] as const;
export const REPORT_KINDS = ['progress', 'blocker', 'decision', 'milestone', 'note'] as const;
export const OUTCOMES = ['advanced', 'unchanged', 'failed'] as const;

export const STAGE_LABELS: Record<string, string> = {
  idea: '概念',
  proposal: '预案',
  validated: '验证',
  build: '开发',
  testing: '调试',
  launch: '上线',
  revenue: '变现',
};

export const AGENT_TOKENS: Array<[string, string]> = [
  ['grokbot', 'GROKBOT_BRIDGE_TOKEN'],
  ['codex', 'CODEX_BRIDGE_TOKEN'],
  ['dev2', 'DEV2_BRIDGE_TOKEN'],
  ['hermes', 'HERMES_BRIDGE_TOKEN'],
  ['openbot', 'OPENBOT_BRIDGE_TOKEN'],
];

/** Owner time zone for "today" — the console's day boundary. */
export const TIME_ZONE = 'Asia/Colombo';

export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

export function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

export function intIn(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed >= min && parsed <= max ? parsed : null;
}

export function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value.trim();
}

export function uuidOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

/** 令牌只存哈希：登记时返回明文一次，之后不可取回。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * 自助登记的 bot 拿到自己的令牌（见 /api/studio/agents）。
 * 只存 sha256；这里查一次、缓存 60 秒，避免每个请求都打库。
 * 查不到就当作匿名——令牌表不存在时也不会让请求 500。
 */
const TOKEN_CACHE = new Map<string, { agent: string | null; at: number }>();
const TOKEN_TTL_MS = 60_000;

async function agentForDbToken(token: string): Promise<string | null> {
  const hash = hashToken(token);
  const cached = TOKEN_CACHE.get(hash);
  if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.agent;

  let agent: string | null = null;
  try {
    const response = await db(`wb_agent_tokens?token_sha256=eq.${hash}&revoked=eq.false&select=agent_id&limit=1`);
    const rows = await readJson<Array<{ agent_id?: string }>>(response);
    agent = Array.isArray(rows) && rows[0]?.agent_id ? rows[0].agent_id : null;
    if (agent) {
      // last_used_at 只是观测信息，写失败不影响鉴权
      void db(`wb_agent_tokens?agent_id=eq.${encodeURIComponent(agent)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }).catch(() => undefined);
    }
  } catch {
    agent = null;
  }
  TOKEN_CACHE.set(hash, { agent, at: Date.now() });
  return agent;
}

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
  // owner 的 Supabase JWT 不会在令牌表里，省一次查库
  if (token.split('.').length === 3) return null;
  return agentForDbToken(token);
}

export function rpc(name: string, body: Record<string, unknown>) {
  return db(`rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
