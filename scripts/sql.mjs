#!/usr/bin/env node
// Run a .sql file against the Supabase project through the Management API.
// Usage: node scripts/sql.mjs supabase/migrations/xxx.sql
// Token: SUPABASE_ACCESS_TOKEN, or ~/.supabase/access-token.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/sql.mjs <file.sql>');
  process.exit(2);
}

const projectRef = process.env.SUPABASE_PROJECT_REF || 'rqfyuepojduhgrreoxvo';
const token = (process.env.SUPABASE_ACCESS_TOKEN || readFileSync(join(homedir(), '.supabase', 'access-token'), 'utf8')).trim();
const sql = readFileSync(file, 'utf8');

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});

const text = await response.text();
console.log(response.status, text.slice(0, 4000));
process.exit(response.ok ? 0 : 1);
