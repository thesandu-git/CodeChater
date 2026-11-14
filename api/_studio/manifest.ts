import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, requireIdentity } from './_shared';

/**
 * 给 AI 看的接口清单。没有任何角色限制：拿到任一令牌就能调任意一层。
 * 制定层（products / projects / schedule / milestones / docs）与执行层（prompt / check / tasks）
 * 只是“用途”分组，不是权限边界。
 */
const MANIFEST = {
  name: 'studio',
  layers: {
    products: '第一层 产品与进度：产品、项目、阶段、进度、参与方',
    kanban: '第二层 Kanban：任务与子任务、五档状态',
    calendar: '第三层 日历/时间线：日程、里程碑、需要主人亲手做的节点',
    log: '第四层 Agent Log：token 来源/bot/项目、空耗、审计、推进',
    relay: '值班室：bot 自助登记、传信员待命（长轮询）、派单队列',
    board: '公告栏：平台更新/修复/通知；传信员用 ?probe=1&since= 检测有没有新公告',
  },
  auth: 'Authorization: Bearer <owner 的 Supabase JWT | 环境里的 bridge 令牌 | POST /api/studio/agents 发的一次性令牌>，权限相同',
  endpoints: [
    { method: 'GET', path: '/api/studio/state', layer: 'all', note: '一次拿全站数据；?day=YYYY-MM-DD' },
    { method: 'GET/POST/PATCH', path: '/api/studio/products', layer: 'products', note: '产品；PATCH ?id=' },
    { method: 'GET/POST/PATCH', path: '/api/studio/projects', layer: 'products', note: '项目；PATCH ?id= 改阶段会写阶段历史' },
    { method: 'GET/POST/PATCH', path: '/api/studio/tasks', layer: 'kanban', note: '任务；列表 ?project= ?status=，单条 ?task=<id>（或 ?id=）；PATCH ?id= 改状态写历史' },
    { method: 'GET/POST/PATCH', path: '/api/studio/milestones', layer: 'calendar', note: '里程碑；due_at=YYYY-MM-DD' },
    { method: 'GET/POST/PATCH/DELETE', path: '/api/studio/schedule', layer: 'calendar', note: '日程；owner_required=true 表示主人必须亲手做' },
    { method: 'GET/POST', path: '/api/studio/docs', layer: 'products', note: '研究/规划文档，挂项目或产品' },
    { method: 'GET', path: '/api/studio/prompt', layer: 'execution', note: '执行摘要 prompt；?task= 或 ?project=' },
    { method: 'POST', path: '/api/studio/check', layer: 'execution', note: '申请检查；{task_id|project_id, reason, day?}' },
    {
      method: 'GET/POST/PATCH/DELETE',
      path: '/api/studio/agents',
      layer: 'relay',
      note: 'bot 登记与心跳；POST 首次返回一次性令牌；换令牌 POST {id, rotate_token:true}（PATCH ?id= {rotate_token:true} 也返回新令牌）；PATCH ?id= {heartbeat:true} 心跳',
    },
    { method: 'POST', path: '/api/studio/dispatch', layer: 'relay', note: '派单入队（只放一行标题+指针）；?id= PATCH 送达/回执，?task_id= 批量收尾' },
    { method: 'GET', path: '/api/studio/inbox', layer: 'relay', note: '传信员待命长轮询；?relay=&wait=25&take=1，有单立刻返回并 claim' },
    { method: 'POST', path: '/api/studio/report', layer: 'execution', note: '进度/阻塞汇报' },
    {
      method: 'GET/POST/PATCH',
      path: '/api/studio/announcements',
      layer: 'board',
      note: '公告栏（平台更新/修复/通知）。GET 列表 ?limit= ?kind= ?since=；传信员探测 GET ?probe=1&since=<cursor>（只回有无新公告，不搬正文）；POST {title, body?, kind?, severity?, audience?, version?}；PATCH ?id= {archived:true} 下架（仅作者或 owner）',
    },
    { method: 'POST', path: '/api/studio/tokens', layer: 'log', note: 'token 记账' },
    { method: 'POST', path: '/api/studio/logs', layer: 'log', note: '每日 Agent log' },
  ],
  task_statuses: ['on_track', 'at_risk', 'blocked', 'completed', 'on_hold'],
  project_statuses: ['not_started', 'active', 'blocked', 'paused', 'done', 'killed', 'cancelled'],
  stages: ['idea', 'proposal', 'validated', 'build', 'testing', 'launch', 'revenue'],
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await requireIdentity(req, res);
  if (!who) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3120';
  const proto = (req.headers['x-forwarded-proto'] as string) || (String(host).startsWith('localhost') ? 'http' : 'https');
  return json(res, 200, { ...MANIFEST, base: `${proto}://${host}`, viewer: who, docs: `${proto}://${host}/api-docs` });
}
