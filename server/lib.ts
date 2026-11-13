import type { VercelRequest, VercelResponse } from '@vercel/node';

export type AgentName = 'grokbot' | 'codex' | 'dev2';
export type TaskStatus = 'pending' | 'working' | 'needs_input' | 'done' | 'failed';

export function json(res: VercelResponse, status: number, value: unknown) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(value);
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value.replace(/\/$/, '');
}

export function supabaseHeaders(key = env('SUPABASE_SERVICE_ROLE_KEY')) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export function bearer(req: VercelRequest): string | null {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
}

/**
 * Reads a token from the environment without throwing.
 * A missing, empty, or whitespace-only value never becomes a matchable secret,
 * so an absent variable can never let an empty bearer token authenticate.
 */
function tokenEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function agentForToken(req: VercelRequest): AgentName | null {
  const token = bearer(req)?.trim();
  if (!token) return null;
  const agents: Array<[AgentName, string]> = [
    ['grokbot', 'GROKBOT_BRIDGE_TOKEN'],
    ['codex', 'CODEX_BRIDGE_TOKEN'],
    ['dev2', 'DEV2_BRIDGE_TOKEN'],
  ];
  for (const [agent, name] of agents) {
    const secret = tokenEnv(name);
    if (secret && token === secret) return agent;
  }
  return null;
}

export async function getOwner(req: VercelRequest): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const response = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json() as { id?: string };
  return user.id ?? null;
}

export async function db(path: string, init: RequestInit = {}) {
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(), ...(init.headers ?? {}) },
  });
}

/**
 * Node's fetch types Response.json() as `unknown`, so every handler that reads a
 * PostgREST body needs a cast. One helper keeps that out of the handlers, and a
 * body that is not JSON becomes null instead of throwing.
 */
export async function readJson<T = any>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return null as T;
  }
}

export function validText(value: unknown, max = 12000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
