import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../_lib';
import { touchAgent } from './_dispatch';
import { json, num, requireIdentity, text } from './_shared';

/**
 * 传信员待命接口（长轮询）。
 *
 *   GET /api/studio/inbox?relay=<传信员 id>&wait=25&take=1
 *
 * 没有任务时这个请求会挂着（默认 20 秒，最多 45 秒），一有派单立刻返回并把该单原子地
 * 标成 claimed（两个传信员同时挂着也只有一个抢到）。返回内容只有 headline + 指针，
 * 不含任务正文——传信员只需要叫醒 bot，细节由 bot 自己去 /api/studio/prompt 取。
 *
 * 超时返回 200 { dispatches: [], timeout: true }，不是错误；按 nextPollMs 继续下一轮。
 */

type Row = Record<string, any>;

const DEFAULT_WAIT_S = 20;
const MAX_WAIT_S = 45;
const POLL_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function candidates(relay: string | null, target: string | null, take: number, cover: boolean): Promise<Row[]> {
  const nowIso = new Date().toISOString();
  const where = [`status=eq.pending`, `expires_at=gt.${nowIso}`];
  if (relay && cover) {
    // 代领：自己名下的 + 还没指定传信员的（谁抢到算谁的，领取时认领）
    where.push(`or=(relay_agent.eq.${encodeURIComponent(relay)},relay_agent.is.null)`);
  } else if (relay) {
    where.push(`relay_agent=eq.${encodeURIComponent(relay)}`);
  } else {
    where.push('relay_agent=is.null');
  }
  if (target) where.push(`target_agent=eq.${encodeURIComponent(target)}`);
  const response = await db(
    `wb_dispatches?select=*&${where.join('&')}&order=priority_rank.asc,created_at.asc&limit=${take}`,
  );
  const rows = await readJson<Row[]>(response);
  return Array.isArray(rows) ? rows : [];
}

/** 原子领取：只有 status 仍是 pending 的那一次更新能拿到行。 */
async function claim(row: Row, relay: string | null, who: string): Promise<Row | null> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: 'claimed',
    claimed_by: relay ?? who,
    claimed_at: nowIso,
    attempts: (Number(row.attempts) || 0) + 1,
    updated_at: nowIso,
  };
  // 没指定传信员的单，领取时记到领取人头上，页面上才看得出谁在管
  if (relay && !row.relay_agent) patch.relay_agent = relay;
  const response = await db(`wb_dispatches?id=eq.${row.id}&status=eq.pending&select=*`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  const rows = await readJson<Row[]>(response);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

let lastSweep = 0;
async function sweepExpired(): Promise<void> {
  if (Date.now() - lastSweep < 30_000) return;
  lastSweep = Date.now();
  try {
    await db(`wb_dispatches?status=eq.pending&expires_at=lt.${new Date().toISOString()}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'expired', note: '过了有效期没人取', updated_at: new Date().toISOString() }),
    });
  } catch {
    /* 清扫失败不影响取单 */
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed. 待命用 GET。' });

  try {
    const relayParam = text(req.query.relay, 32);
    const target = text(req.query.target, 32);
    if (relayParam === undefined || target === undefined) {
      return json(res, 400, { error: 'relay/target 太长。' });
    }
    const relay = relayParam ?? (who.role === 'agent' ? who.id : null);
    const cover = req.query.cover === '1' || req.query.cover === 'true';
    const take = Math.round(num(req.query.take, 1, 10) ?? 1);
    const waitS = Math.min(Math.max(num(req.query.wait, 0, MAX_WAIT_S) ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S);

    await Promise.all([sweepExpired(), relay ? touchAgent(relay) : Promise.resolve()]);

    const startedAt = Date.now();
    const deadline = startedAt + waitS * 1000;
    const claimed: Row[] = [];

    if (waitS === 0) {
      for (const row of await candidates(relay, target, take, cover)) {
        const got = await claim(row, relay, who.id);
        if (got) claimed.push(got);
        if (claimed.length >= take) break;
      }
    } else {
      while (true) {
        for (const row of await candidates(relay, target, take - claimed.length, cover)) {
          const got = await claim(row, relay, who.id);
          if (got) claimed.push(got);
          if (claimed.length >= take) break;
        }
        if (claimed.length >= take) break;
        const left = deadline - Date.now();
        if (left < POLL_MS) break;
        await sleep(Math.min(POLL_MS, left));
      }
    }

    return json(res, 200, {
      dispatches: claimed.map((d) => ({
        id: d.id,
        kind: d.kind,
        headline: d.headline,
        hint: d.hint,
        priority: d.priority,
        target_agent: d.target_agent,
        task_id: d.task_id,
        project_id: d.project_id,
        expires_at: d.expires_at,
        created_at: d.created_at,
        status: d.status,
        claimed_at: d.claimed_at,
        // bot 醒了自己取正文，传信员不用搬运内容
        prompt_url: d.task_id ? `/api/studio/prompt?task=${d.task_id}` : null,
      })),
      timeout: claimed.length === 0,
      waitedMs: Date.now() - startedAt,
      relay,
      cover,
      nextPollMs: claimed.length ? 0 : POLL_MS,
      note: claimed.length
        ? '已领取（claimed）。叫醒 bot 后 PATCH /api/studio/dispatch?id=<id> {status:"delivered"}。'
        : '这段时间没有新派单；按 nextPollMs 继续待命。',
    });
  } catch (error) {
    return json(res, 503, { error: '待命接口不可用。', detail: String((error as Error)?.message ?? error) });
  }
}
