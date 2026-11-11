import type { VercelRequest } from '@vercel/node';
import { db, env } from '../_lib';

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

/** Agent identity from a bearer token. A missing env var never matches. */
export function wbAgent(req: VercelRequest): string | null {
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
  return null;
}

export function rpc(name: string, body: Record<string, unknown>) {
  return db(`rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
