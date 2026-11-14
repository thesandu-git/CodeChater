import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, json, readJson, validText } from '../_lib';
import { intIn, oneOf, optionalText, requireIdentity } from './_shared';

/**
 * 公告栏：平台层面的「更新 / 修了什么 bug / 通知」。
 *
 * 两个用法：
 *   1. 人看：GET /api/studio/announcements 拿正文列表，Studio 的「公告」页也是这条。
 *   2. 传信员看：GET /api/studio/announcements?probe=1&since=<cursor>
 *      只回「有没有新的 + 最新一条的标题」，不搬正文，一次两行小查询。
 *
 * 谁都能写（owner 或任一 bot 令牌），但改/归档只限作者本人或 owner。
 * 没有 DELETE：审计链不靠绕接口清库，过期公告用 archived 下架。
 */

const KINDS = ['update', 'fix', 'notice', 'incident'] as const;
const SEVERITIES = ['info', 'important', 'critical'] as const;
const AUDIENCES = ['all', 'relay', 'bot', 'owner'] as const;

type Row = Record<string, any>;

const LIST_FIELDS = 'id,kind,severity,audience,version,title,body,created_by,published_at,updated_at,archived,archived_at';
const PROBE_FIELDS = 'id,kind,severity,audience,version,title,published_at';

/** 时间戳原样保留：`new Date()` 会把微秒截成毫秒，回传给自己就漏一条。 */
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!ISO_SHAPE.test(raw) || Number.isNaN(new Date(raw).getTime())) return null;
  return raw;
}

function truthy(value: unknown): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

/** `audience=relay` 意思是「传给 relay 看的」＝ audience in (all, relay)。 */
function audienceFilter(value: unknown): string {
  const one = oneOf(value, AUDIENCES);
  if (!one || one === 'all') return '';
  return `&audience=in.(all,${one})`;
}

async function newest(fields: string, extra = ''): Promise<Row | null> {
  const response = await db(`wb_announcements?select=${fields}&archived=eq.false${extra}&order=published_at.desc,id.desc&limit=1`);
  const rows = await readJson<Row[]>(response);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const who = await requireIdentity(req, res);
    if (!who) return;

    if (req.method === 'GET') {
      const since = isoTime(req.query.since);
      if (req.query.since !== undefined && !since) {
        return json(res, 400, { error: 'since must be an ISO timestamp, e.g. 2026-11-14T05:00:00Z.' });
      }
      const audience = audienceFilter(req.query.audience);
      const latest = await newest(PROBE_FIELDS, audience);

      // ── 传信员的轻量探测：不搬正文 ─────────────────────────────────────
      if (truthy(req.query.probe)) {
        let fresh: Row[] = [];
        if (since) {
          const response = await db(
            `wb_announcements?select=id,kind,severity,published_at&archived=eq.false${audience}` +
            `&published_at=gt.${encodeURIComponent(since)}&order=published_at.desc&limit=200`,
          );
          const rows = await readJson<Row[]>(response);
          fresh = Array.isArray(rows) ? rows : [];
        }
        return json(res, 200, {
          probe: true,
          changed: fresh.length > 0,
          new_count: fresh.length,
          kinds: [...new Set(fresh.map((r) => r.kind))],
          latest: latest
            ? {
                id: latest.id,
                kind: latest.kind,
                severity: latest.severity,
                audience: latest.audience,
                version: latest.version,
                title: latest.title,
                published_at: latest.published_at,
              }
            : null,
          cursor: latest?.published_at ?? since,
          since: since ?? null,
          server_time: new Date().toISOString(),
        });
      }

      // ── 正文列表 ────────────────────────────────────────────────────────
      const limit = intIn(req.query.limit ?? 20, 1, 100) ?? 20;
      const kind = oneOf(req.query.kind, KINDS);
      const includeArchived = truthy(req.query.archived);
      const filters = [
        includeArchived ? '' : 'archived=eq.false',
        kind ? `kind=eq.${kind}` : '',
      ].filter(Boolean).join('&');
      const response = await db(
        `wb_announcements?select=${LIST_FIELDS}${filters ? `&${filters}` : ''}${audience}` +
        `${since ? `&published_at=gt.${encodeURIComponent(since)}` : ''}` +
        `&order=published_at.desc,id.desc&limit=${limit}`,
      );
      const rows = await readJson<Row[]>(response);
      if (!response.ok) return json(res, response.status, { error: 'Could not read announcements.', detail: rows });
      const list = Array.isArray(rows) ? rows : [];
      return json(res, 200, {
        announcements: list,
        count: list.length,
        latest: latest ? { id: latest.id, kind: latest.kind, version: latest.version, title: latest.title, published_at: latest.published_at } : null,
        cursor: list[0]?.published_at ?? latest?.published_at ?? since,
        since: since ?? null,
        server_time: new Date().toISOString(),
      });
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!validText(body.title, 200)) {
        return json(res, 400, { error: 'A title (1-200 chars) is required.' });
      }
      const kind = oneOf(body.kind, KINDS) ?? 'notice';
      const severity = oneOf(body.severity, SEVERITIES) ?? (kind === 'incident' ? 'important' : 'info');
      const audience = oneOf(body.audience, AUDIENCES) ?? 'all';
      const content = optionalText(body.body ?? body.detail, 8000);
      if (content === undefined) return json(res, 400, { error: 'body is too long (max 8000).' });
      const version = optionalText(body.version, 40);
      if (version === undefined) return json(res, 400, { error: 'version is too long (max 40).' });

      const inserted = await db('wb_announcements?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          kind,
          severity,
          audience,
          version: version ?? null,
          title: body.title.trim(),
          body: content ?? '',
          created_by: who.role === 'owner' ? 'owner' : who.id,
        }),
      });
      const rows = await readJson<Row[]>(inserted);
      if (!inserted.ok) return json(res, 400, { error: 'Could not publish the announcement.', detail: rows });
      const row = rows[0];
      return json(res, 201, {
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        audience: row.audience,
        version: row.version,
        title: row.title,
        published_at: row.published_at,
        created_by: row.created_by,
        cursor: row.published_at,
      });
    }

    if (req.method === 'PATCH') {
      const id = typeof req.query.id === 'string' ? req.query.id : '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'id (uuid) is required.' });

      const found = await db(`wb_announcements?id=eq.${id}&select=*&limit=1`);
      const rows = await readJson<Row[]>(found);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return json(res, 404, { error: `Announcement not found: ${id}` });
      if (who.role !== 'owner' && row.created_by !== who.id) {
        return json(res, 403, { error: 'Only the author or the owner can edit an announcement.', author: row.created_by });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Row = { updated_at: new Date().toISOString() };

      if (body.archived !== undefined) {
        patch.archived = truthy(body.archived);
        patch.archived_at = patch.archived ? new Date().toISOString() : null;
      }
      if (body.title !== undefined) {
        if (!validText(body.title, 200)) return json(res, 400, { error: 'title must be 1-200 chars.' });
        patch.title = body.title.trim();
      }
      if (body.body !== undefined) {
        const content = optionalText(body.body, 8000);
        if (content === undefined) return json(res, 400, { error: 'body is too long (max 8000).' });
        patch.body = content ?? '';
      }
      if (body.kind !== undefined) {
        const kind = oneOf(body.kind, KINDS);
        if (!kind) return json(res, 400, { error: `kind must be one of: ${KINDS.join(', ')}` });
        patch.kind = kind;
      }
      if (body.severity !== undefined) {
        const severity = oneOf(body.severity, SEVERITIES);
        if (!severity) return json(res, 400, { error: `severity must be one of: ${SEVERITIES.join(', ')}` });
        patch.severity = severity;
      }
      if (body.audience !== undefined) {
        const audience = oneOf(body.audience, AUDIENCES);
        if (!audience) return json(res, 400, { error: `audience must be one of: ${AUDIENCES.join(', ')}` });
        patch.audience = audience;
      }
      if (body.version !== undefined) {
        const version = optionalText(body.version, 40);
        if (version === undefined) return json(res, 400, { error: 'version is too long (max 40).' });
        patch.version = version ?? null;
      }

      const updated = await db(`wb_announcements?id=eq.${id}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const out = await readJson<Row[]>(updated);
      if (!updated.ok) return json(res, 400, { error: 'Could not update the announcement.', detail: out });
      return json(res, 200, out[0]);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: 'Studio is not configured.' });
  }
}
