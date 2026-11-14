import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { db, env, json, readJson } from '../_lib';
import { intIn, requireIdentity, uuid } from './_shared';

/**
 * 任务附件。
 *
 * 文件放 Supabase Storage 的私有桶 `studio-attachments`，元数据在 wb_attachments。
 * 两条上传路：
 *   1. 小文件一次调用：POST {task_id, filename, content_base64}（base64 后 ≤4MB）
 *   2. 大文件直传：POST ?upload_url=1 拿签名 URL → PUT 文件 → POST {task_id, path} 确认
 * 下载：GET ?id=<id>&download=1 走 302 到签名 URL（curl -L 直接落盘），?id=&json=1 拿链接本身。
 */

const BUCKET = 'studio-attachments';
const UPLOAD_TTL = 7200;
const DOWNLOAD_TTL = 3600;
const INLINE_MAX = 3 * 1024 * 1024;

type Row = Record<string, any>;

const FIELDS = 'id,task_id,filename,mime,size_bytes,storage_path,uploaded_by,note,created_at';

function storageUrl(): string {
  return `${env('SUPABASE_URL')}/storage/v1`;
}

function storageHeaders(extra: Record<string, string> = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function safeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f]/g, '');
  if (!name || name.length > 200) return null;
  return name;
}

/** `text/plain; charset=utf-8` 这种带参数的会被存储拒绝，只留主类型。 */
function safeMime(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream';
  const value = raw.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value) && value.length <= 100 ? value : 'application/octet-stream';
}

/** 每个路径段单独编码，中文文件名也能用。 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function origin(req: VercelRequest): string {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3120';
  const proto = (req.headers['x-forwarded-proto'] as string) || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function taskExists(taskId: string): Promise<boolean> {
  const response = await db(`wb_tasks?id=eq.${taskId}&select=id&limit=1`);
  const rows = await readJson<Row[]>(response);
  return Array.isArray(rows) && rows.length > 0;
}

function view(req: VercelRequest, row: Row) {
  return {
    id: row.id,
    task_id: row.task_id,
    filename: row.filename,
    mime: row.mime,
    size_bytes: Number(row.size_bytes) || 0,
    uploaded_by: row.uploaded_by,
    note: row.note ?? null,
    created_at: row.created_at,
    download: `${origin(req)}/api/studio/attachments?id=${row.id}&download=1`,
  };
}

/** Storage 只认 ASCII key：中文名留在库里的 filename，路径用 uuid + 扩展名。 */
function extensionOf(filename: string): string {
  const match = filename.match(/\.([A-Za-z0-9]{1,10})$/);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function signedUploadPath(taskId: string, filename: string): string {
  return `tasks/${taskId}/${randomUUID()}${extensionOf(filename)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const who = await requireIdentity(req, res);
    if (!who) return;

    if (req.method === 'GET') {
      const id = uuid(req.query.id);
      if (id === undefined) return json(res, 400, { error: 'id 无效。' });

      // ── 单条：签名下载链接（302 或 JSON） ─────────────────────────────
      if (id) {
        const found = await db(`wb_attachments?id=eq.${id}&select=${FIELDS}&limit=1`);
        const rows = await readJson<Row[]>(found);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return json(res, 404, { error: '附件不存在。' });

        const sign = await fetch(`${storageUrl()}/object/sign/${BUCKET}/${encodePath(row.storage_path)}`, {
          method: 'POST',
          headers: storageHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ expiresIn: DOWNLOAD_TTL }),
        });
        const signed = await readJson<{ signedURL?: string; message?: string }>(sign);
        if (!sign.ok || !signed?.signedURL) {
          return json(res, 502, { error: '签名下载链接生成失败。', detail: signed?.message ?? sign.status });
        }
        const url = `${storageUrl()}${signed.signedURL}`;
        if (req.query.json !== undefined) {
          return json(res, 200, { id: row.id, filename: row.filename, mime: row.mime, url, expires_in: DOWNLOAD_TTL });
        }
        res.statusCode = 302;
        res.setHeader('Location', url);
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }

      // ── 列表：按任务 ─────────────────────────────────────────────────
      const taskId = uuid(req.query.task);
      if (taskId === undefined) return json(res, 400, { error: 'task 无效。' });
      if (!taskId) return json(res, 400, { error: '给 task=<任务 id> 或 id=<附件 id>。' });

      const limit = intIn(req.query.limit ?? 100, 1, 200) ?? 100;
      const response = await db(
        `wb_attachments?task_id=eq.${taskId}&select=${FIELDS}&order=created_at.asc&limit=${limit}`,
      );
      const rows = await readJson<Row[]>(response);
      if (!response.ok) return json(res, response.status, { error: '读取附件失败。', detail: rows });
      const list = (Array.isArray(rows) ? rows : []).map((row) => view(req, row));
      return json(res, 200, { task_id: taskId, attachments: list, count: list.length });
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskId = uuid(body.task_id);
      if (!taskId) return json(res, 400, { error: 'task_id 必填（uuid）。' });
      if (!(await taskExists(taskId))) return json(res, 404, { error: `任务不存在：${taskId}` });

      // ── 1) 要一个直传签名 URL（大文件） ───────────────────────────────
      if (req.query.upload_url !== undefined) {
        const filename = safeName(body.filename);
        if (!filename) return json(res, 400, { error: 'filename 必填（1-200 字，不能带路径分隔符）。' });
        const mime = safeMime(body.mime);
        const path = await signedUploadPath(taskId, filename);

        const sign = await fetch(`${storageUrl()}/object/upload/sign/${BUCKET}/${encodePath(path)}`, {
          method: 'POST',
          headers: storageHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ expiresIn: UPLOAD_TTL }),
        });
        const signed = await readJson<{ url?: string; message?: string }>(sign);
        if (!sign.ok || !signed?.url) {
          return json(res, 502, { error: '签名上传链接生成失败。', detail: signed?.message ?? sign.status });
        }
        return json(res, 200, {
          task_id: taskId,
          path,
          filename,
          mime,
          method: 'PUT',
          upload_url: `${storageUrl()}${signed.url}`,
          headers: { 'Content-Type': mime, 'x-upsert': 'false' },
          expires_in: UPLOAD_TTL,
          next: 'PUT 文件到 upload_url 后，POST /api/studio/attachments {task_id, path} 确认登记',
        });
      }

      const filename = safeName(body.filename);
      if (!filename) return json(res, 400, { error: 'filename 必填（1-200 字，不能带路径分隔符）。' });
      const mime = safeMime(body.mime);
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

      let path: string;
      let size = 0;

      if (typeof body.path === 'string' && body.path.trim()) {
        // ── 2) 确认直传：文件应该已经在桶里 ─────────────────────────────
        path = body.path.trim();
        if (!path.startsWith(`tasks/${taskId}/`)) {
          return json(res, 400, { error: 'path 不属于这个任务（应来自 ?upload_url=1 的返回）。' });
        }
        const head = await fetch(`${storageUrl()}/object/${BUCKET}/${encodePath(path)}`, {
          method: 'HEAD',
          headers: storageHeaders(),
        });
        if (!head.ok) {
          return json(res, 400, {
            error: '文件还没传上来（或已过期）。',
            hint: '先把文件 PUT 到 upload_url，再带同一个 path 调这个接口。',
          });
        }
        size = Number(head.headers.get('content-length')) || 0;
        const storedMime = head.headers.get('content-type');
        if (storedMime && storedMime !== 'application/octet-stream') {
          // 以实际存储的类型为准，但保留调用方给的文件名
        }
      } else if (typeof body.content_base64 === 'string' && body.content_base64) {
        // ── 3) 小文件内联：一次调用完成 ─────────────────────────────────
        let buffer: Buffer;
        try {
          buffer = Buffer.from(body.content_base64.replace(/^data:[^,]+,/, ''), 'base64');
        } catch {
          return json(res, 400, { error: 'content_base64 解码失败。' });
        }
        if (!buffer.length) return json(res, 400, { error: 'content_base64 解出来是空的。' });
        if (buffer.length > INLINE_MAX) {
          return json(res, 400, {
            error: `内联上传最大 ${Math.round(INLINE_MAX / 1024 / 1024)}MB。`,
            hint: '更大的文件走两段式：POST ?upload_url=1 → PUT 文件 → POST {task_id, path}。',
          });
        }
        path = await signedUploadPath(taskId, filename);
        const put = await fetch(`${storageUrl()}/object/${BUCKET}/${encodePath(path)}`, {
          method: 'POST',
          headers: storageHeaders({ 'Content-Type': mime, 'x-upsert': 'false' }),
          body: buffer,
        });
        if (!put.ok) {
          const detail = await readJson(put);
          return json(res, 502, { error: '文件写进存储失败。', detail });
        }
        size = buffer.length;
      } else {
        return json(res, 400, { error: '给 content_base64（小文件）或 path（直传后确认）。' });
      }

      const inserted = await db(`wb_attachments?select=${FIELDS}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          task_id: taskId,
          filename,
          mime,
          size_bytes: size,
          storage_path: path,
          uploaded_by: who.role === 'owner' ? 'owner' : who.id,
          note,
        }),
      });
      const rows = await readJson<Row[]>(inserted);
      if (!inserted.ok) return json(res, 400, { error: '附件登记失败。', detail: rows });
      return json(res, 201, view(req, rows[0]));
    }

    if (req.method === 'DELETE') {
      const id = uuid(req.query.id);
      if (!id) return json(res, 400, { error: 'id 必填（uuid）。' });
      const found = await db(`wb_attachments?id=eq.${id}&select=${FIELDS}&limit=1`);
      const rows = await readJson<Row[]>(found);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return json(res, 404, { error: '附件不存在。' });
      if (who.role !== 'owner' && row.uploaded_by !== who.id) {
        return json(res, 403, { error: '只有上传者本人或 owner 能删附件。', uploaded_by: row.uploaded_by });
      }
      await fetch(`${storageUrl()}/object/${BUCKET}/${encodePath(row.storage_path)}`, {
        method: 'DELETE',
        headers: storageHeaders(),
      }).catch(() => undefined);
      const removed = await db(`wb_attachments?id=eq.${id}`, { method: 'DELETE' });
      if (!removed.ok) return json(res, 400, { error: '附件删除失败。' });
      return json(res, 200, { id, deleted: true });
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch {
    return json(res, 503, { error: '附件服务未配置。' });
  }
}
