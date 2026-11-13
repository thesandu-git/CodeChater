import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env, json } from '../server/lib';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    json(res, 200, { supabaseUrl: env('SUPABASE_URL'), supabaseAnonKey: env('SUPABASE_ANON_KEY') });
  } catch {
    json(res, 503, { error: 'Console setup is incomplete.' });
  }
}
