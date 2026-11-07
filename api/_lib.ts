import type { VercelRequest, VercelResponse } from '@vercel/node';

export type AgentName = 'grokbot' | 'codex';
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

export function agentForToken(req: VercelRequest): AgentName | null {
  const token = bearer(req);
  if (!token) return null;
  if (token === env('GROKBOT_BRIDGE_TOKEN')) return 'grokbot';
  if (token === env('CODEX_BRIDGE_TOKEN')) return 'codex';
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

export function validText(value: unknown, max = 12000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
