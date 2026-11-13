import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getOwner, json } from '../lib';
import { wbAgent } from '../workbench/_shared';

export { json };

export const TZ = 'Asia/Colombo';
export const STAGES = ['idea', 'proposal', 'validated', 'build', 'testing', 'launch', 'revenue'] as const;
export const PROJECT_STATUSES = ['not_started', 'active', 'blocked', 'paused', 'done', 'killed', 'cancelled'] as const;
export const TASK_STATUSES = ['on_track', 'at_risk', 'blocked', 'completed', 'on_hold'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const SCHEDULE_KINDS = ['work', 'review', 'decision', 'owner', 'milestone', 'payment'] as const;
export const DOC_KINDS = ['research', 'spec', 'report', 'note'] as const;

export type Identity = { role: 'owner' | 'agent'; id: string };

/**
 * 任何身份都能调任何一层：owner 的 Supabase JWT，或任一 bot 的 bridge 令牌。
 * 这里不做角色区分——限制只存在于“谁拿到令牌”，不在接口层。
 */
export async function identify(req: VercelRequest): Promise<Identity | null> {
  const agent = await wbAgent(req);
  if (agent) return { role: 'agent', id: agent };
  try {
    const owner = await getOwner(req);
    return owner ? { role: 'owner', id: owner } : null;
  } catch {
    return null;
  }
}

export async function requireIdentity(req: VercelRequest, res: VercelResponse): Promise<Identity | null> {
  const who = await identify(req);
  if (!who) {
    json(res, 401, { error: '需要一个 Supabase 登录令牌或 bot 的 bridge 令牌。', hint: 'Authorization: Bearer <token>' });
    return null;
  }
  return who;
}

export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value;
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 本地日界线（科伦坡）的 0 点，转成 UTC ISO。 */
export function dayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}

export function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T[number]) : null;
}

export function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value.trim();
}

export function uuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

export function num(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}
