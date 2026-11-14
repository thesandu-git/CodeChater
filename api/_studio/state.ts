import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, readJson } from '../_lib';
import {
  STAGES, addDays, dayStartIso, json, parseDay, requireIdentity, today,
} from './_shared';

type Row = Record<string, any>;

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s, i + 1]));

async function rows(path: string): Promise<Row[]> {
  const res = await db(path);
  const data = await readJson<Row[]>(res);
  if (!Array.isArray(data)) throw new Error(`PostgREST ${res.status} for ${path.split('?')[0]}`);
  return data;
}

/** 值班室是新加的：视图/表还没迁移时，别的层照常显示。 */
async function safeRows(path: string): Promise<Row[]> {
  try {
    return await rows(path);
  } catch {
    return [];
  }
}

function localDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const who = await requireIdentity(req, res);
  if (!who) return;

  try {
    const day = parseDay(req.query.day) ?? today();
    const from = addDays(day, -30);
    const to = addDays(day, 60);
    const tokenFrom = addDays(day, -29);
    const scheduleFrom = dayStartIso(addDays(day, -31));
    const scheduleTo = dayStartIso(addDays(day, 61));

    const [agents, products, projects, tasks, milestones, docs, schedule, reports, tokens, logs, medians, taskEvents, desk, dispatches, announcements, attachments] = await Promise.all([
      rows('wb_agents?select=*&order=id'),
      rows('wb_products?select=*&order=created_at.asc'),
      rows('wb_studio_projects?select=*&limit=400'),
      rows('wb_tasks?select=*&order=order_index.asc,created_at.asc&limit=2000'),
      rows('wb_milestones?select=*&order=due_at.asc&limit=1000'),
      rows('wb_docs?select=*&order=created_at.desc&limit=500'),
      rows(`wb_schedule?select=*&start_at=gte.${encodeURIComponent(scheduleFrom)}&start_at=lt.${encodeURIComponent(scheduleTo)}&order=start_at.asc&limit=2000`),
      rows(`wb_reports?select=*&created_at=gte.${encodeURIComponent(dayStartIso(tokenFrom))}&order=created_at.desc&limit=1000`),
      // 窗口按 ?day 收口：[day-29, day]。只给下界时 day 只挪起点，不同 day 读到同一批行，
      // byAgent/byProject/byModel 看起来“换了 day 不变”。
      rows(`wb_token_usage?select=*&day=gte.${tokenFrom}&day=lte.${day}&order=day.asc&limit=5000`),
      rows(`wb_agent_logs?select=*&day=gte.${addDays(day, -13)}&day=lte.${day}&order=day.desc&limit=200`),
      rows('wb_stage_median?select=*'),
      rows(`wb_task_events?select=*&created_at=gte.${encodeURIComponent(dayStartIso(tokenFrom))}&order=created_at.desc&limit=1000`),
      safeRows('wb_relay_desk?select=*&order=kind.asc,id.asc&limit=300'),
      safeRows('wb_dispatches?select=*&status=in.(pending,claimed,delivered)&order=created_at.desc&limit=300'),
      safeRows('wb_announcements?select=*&archived=eq.false&order=published_at.desc,id.desc&limit=20'),
      safeRows('wb_attachments?select=id,task_id,filename,mime,size_bytes,uploaded_by,note,created_at&order=created_at.desc&limit=500'),
    ]);

    const agentName = new Map(agents.map((a) => [a.id, a.display_name]));
    const medianByStage = new Map(medians.map((m) => [m.stage as string, Number(m.median_days) || 0]));
    const medianSamples = new Map(medians.map((m) => [m.stage as string, Number(m.samples) || 0]));

    const etaFor = (stage: string) => {
      if (stage === 'revenue') return { etaDays: 0, etaComplete: true, missing: [] as string[] };
      const idx = STAGE_INDEX[stage] ?? 1;
      const remaining = STAGES.slice(idx);
      const missing = remaining.filter((s) => (medianSamples.get(s) ?? 0) < 2);
      if (missing.length) return { etaDays: null, etaComplete: false, missing };
      const days = remaining.reduce((sum, s) => sum + (medianByStage.get(s) ?? 0), 0);
      return { etaDays: Math.round(days), etaComplete: true, missing: [] as string[] };
    };

    const tasksByProject = new Map<string, Row[]>();
    for (const t of tasks) {
      if (!tasksByProject.has(t.project_id)) tasksByProject.set(t.project_id, []);
      tasksByProject.get(t.project_id)!.push(t);
    }
    const milestonesByProject = new Map<string, Row[]>();
    for (const m of milestones) {
      if (!milestonesByProject.has(m.project_id)) milestonesByProject.set(m.project_id, []);
      milestonesByProject.get(m.project_id)!.push(m);
    }
    const docsByProject = new Map<string, Row[]>();
    const docsByProduct = new Map<string, Row[]>();
    for (const d of docs) {
      if (d.project_id) {
        if (!docsByProject.has(d.project_id)) docsByProject.set(d.project_id, []);
        docsByProject.get(d.project_id)!.push(d);
      }
      if (d.product_id) {
        if (!docsByProduct.has(d.product_id)) docsByProduct.set(d.product_id, []);
        docsByProduct.get(d.product_id)!.push(d);
      }
    }

    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const projectProduct = new Map(projects.map((p) => [p.id, p.product_id]));
    const projectStuck = new Map(projects.map((p) => [p.id, Boolean(p.is_stuck)]));

    const tokensByProjectAgent = new Map<string, number>();
    const tokensByProject = new Map<string, number>();
    const tokensByAgent = new Map<string, number>();
    const tokensByModel = new Map<string, number>();
    const tokensByDay = new Map<string, { tokens: number; waste: number }>();
    const agentDayTokens = new Map<string, { tokens: number; waste: number; projects: Set<string> }>();

    for (const t of tokens) {
      const total = (Number(t.tokens_in) || 0) + (Number(t.tokens_out) || 0);
      const waste = Number(t.waste_tokens) || 0;
      if (t.project_id) {
        tokensByProjectAgent.set(`${t.project_id}:${t.agent}`, (tokensByProjectAgent.get(`${t.project_id}:${t.agent}`) ?? 0) + total);
        tokensByProject.set(t.project_id, (tokensByProject.get(t.project_id) ?? 0) + total);
      }
      tokensByAgent.set(t.agent, (tokensByAgent.get(t.agent) ?? 0) + total);
      const model = t.model || '未标注';
      tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + total);
      const d = tokensByDay.get(t.day) ?? { tokens: 0, waste: 0 };
      d.tokens += total;
      d.waste += waste;
      tokensByDay.set(t.day, d);
      if (t.day === day) {
        const ad = agentDayTokens.get(t.agent) ?? { tokens: 0, waste: 0, projects: new Set<string>() };
        ad.tokens += total;
        ad.waste += waste;
        if (t.project_id) ad.projects.add(t.project_id);
        agentDayTokens.set(t.agent, ad);
      }
    }

    const reportsByProjectAgent = new Map<string, { n: number; last: string | null }>();
    const advancesByAgent = new Map<string, Set<string>>();
    const reportsToday = new Map<string, number>();
    for (const r of reports) {
      if (r.project_id) {
        const key = `${r.project_id}:${r.agent}`;
        const cur = reportsByProjectAgent.get(key) ?? { n: 0, last: null };
        cur.n += 1;
        if (!cur.last || r.created_at > cur.last) cur.last = r.created_at;
        reportsByProjectAgent.set(key, cur);
      }
      if (localDay(r.created_at) === day) {
        reportsToday.set(r.agent, (reportsToday.get(r.agent) ?? 0) + 1);
        if (r.outcome === 'advanced' && r.project_id) {
          if (!advancesByAgent.has(r.agent)) advancesByAgent.set(r.agent, new Set());
          advancesByAgent.get(r.agent)!.add(r.project_id);
        }
      }
    }

    const projected: Row[] = projects.map((p) => {
      const pt = tasksByProject.get(p.id) ?? [];
      const done = pt.filter((t) => t.status === 'completed').length;
      const ratio = pt.length ? done / pt.length : 0;
      const stageIdx = STAGE_INDEX[p.stage] ?? 1;
      const progress = Number(p.progress) > 0
        ? Number(p.progress)
        : pt.length
          ? Math.round(ratio * 100)
          : Math.round(((stageIdx - 0.5) / STAGES.length) * 100);
      const participants = new Map<string, { agent: string; tokens: number; reports: number; tasks: number; lastAt: string | null }>();
      for (const [key, value] of tokensByProjectAgent) {
        const [projectId, agent] = key.split(':');
        if (projectId !== p.id) continue;
        participants.set(agent, { agent, tokens: value, reports: 0, tasks: 0, lastAt: null });
      }
      for (const [key, value] of reportsByProjectAgent) {
        const [projectId, agent] = key.split(':');
        if (projectId !== p.id) continue;
        const cur = participants.get(agent) ?? { agent, tokens: 0, reports: 0, tasks: 0, lastAt: null };
        cur.reports = value.n;
        cur.lastAt = value.last;
        participants.set(agent, cur);
      }
      for (const t of pt) {
        if (!t.assignee_agent) continue;
        const cur = participants.get(t.assignee_agent) ?? { agent: t.assignee_agent, tokens: 0, reports: 0, tasks: 0, lastAt: null };
        cur.tasks += 1;
        participants.set(t.assignee_agent, cur);
      }
      const currentTask = pt
        .filter((t) => t.status !== 'completed')
        .sort((a, b) => {
          const rank = (s: string) => ({ blocked: 0, at_risk: 1, on_track: 2, on_hold: 3 }[s] ?? 4);
          return rank(a.status) - rank(b.status) || (a.order_index ?? 0) - (b.order_index ?? 0);
        })[0] ?? null;
      const eta = etaFor(p.stage);
      return {
        ...p,
        progressPct: progress,
        taskCount: pt.length,
        taskDone: done,
        activeTasks: pt.filter((t) => t.status !== 'completed').length,
        participants: [...participants.values()]
          .map((x) => ({ ...x, name: agentName.get(x.agent) ?? x.agent }))
          .sort((a, b) => b.tokens - a.tokens || b.reports - a.reports),
        currentTask,
        milestones: milestonesByProject.get(p.id) ?? [],
        docs: docsByProject.get(p.id) ?? [],
        tasks: pt,
        etaDays: eta.etaDays,
        etaComplete: eta.etaComplete,
        etaMissing: eta.missing,
        productName: p.product_name ?? null,
      };
    });

    const productProjects = new Map<string, Row[]>();
    for (const p of projected) {
      if (!p.product_id) continue;
      if (!productProjects.has(p.product_id)) productProjects.set(p.product_id, []);
      productProjects.get(p.product_id)!.push(p);
    }

    const productSummaries = products.map((prod) => {
      const list = productProjects.get(prod.id) ?? [];
      const live = list.filter((p) => !['killed', 'cancelled'].includes(p.status));
      const avg = live.length ? Math.round(live.reduce((s, p) => s + p.progressPct, 0) / live.length) : 0;
      const stageIdx = live.length
        ? Math.max(...live.map((p) => STAGE_INDEX[p.stage] ?? 1))
        : 1;
      const etas = live.map((p) => p.etaDays).filter((v) => v !== null) as number[];
      const allKnown = live.length > 0 && live.every((p) => p.etaDays !== null);
      return {
        ...prod,
        projectIds: live.map((p) => p.id),
        projectCount: list.length,
        liveProjects: live.length,
        doneProjects: list.filter((p) => p.status === 'done').length,
        stuckProjects: live.filter((p) => p.is_stuck).length,
        progressPct: avg,
        stage: STAGES[Math.max(0, stageIdx - 1)],
        // 慢的那个决定产品离变现还有多远
        etaDays: allKnown && etas.length ? Math.max(...etas) : null,
        etaComplete: allKnown,
        docs: docsByProduct.get(prod.id) ?? [],
        projects: list.map((p) => ({
          id: p.id, name: p.name, status: p.status, stage: p.stage,
          progressPct: p.progressPct, isStuck: p.is_stuck, etaDays: p.etaDays,
          lastReport: p.last_report,
        })),
      };
    });

    const scheduleItems: Row[] = schedule.map((s) => ({
      ...s,
      day: localDay(s.start_at),
      projectName: s.project_id ? projectName.get(s.project_id) ?? null : null,
    }));

    const calendar = new Map<string, Row[]>();
    for (const s of scheduleItems) {
      if (!s.day) continue;
      if (!calendar.has(s.day)) calendar.set(s.day, []);
      calendar.get(s.day)!.push(s);
    }

    // 过去每天完成的东西：任务完成 + 日程打勾 + 阶段推进
    const completedByDay = new Map<string, Row[]>();
    const pushDone = (date: string, item: Row) => {
      if (!completedByDay.has(date)) completedByDay.set(date, []);
      completedByDay.get(date)!.push(item);
    };
    for (const t of tasks) {
      const d = localDay(t.completed_at);
      if (d) pushDone(d, { type: 'task', title: t.title, projectId: t.project_id, projectName: projectName.get(t.project_id) ?? null });
    }
    for (const s of scheduleItems) {
      if (s.done && s.day) pushDone(s.day, { type: 'schedule', title: s.title, projectId: s.project_id, projectName: s.projectName });
    }
    for (const e of taskEvents) {
      const d = localDay(e.created_at);
      if (d && e.to_status === 'completed') {
        const task = tasks.find((t) => t.id === e.task_id);
        if (task) pushDone(d, { type: 'task', title: task.title, projectId: task.project_id, projectName: projectName.get(task.project_id) ?? null });
      }
    }

    const events: Row[] = [];
    for (const t of tasks) {
      const date = t.due_at || t.start_at;
      if (!date) continue;
      events.push({
        date, type: 'task', title: t.title, status: t.status, priority: t.priority,
        projectId: t.project_id, projectName: projectName.get(t.project_id) ?? null,
        ownerRequired: Boolean(t.owner_required), assignee: t.assignee_agent,
      });
    }
    for (const m of milestones) {
      events.push({
        date: m.due_at, type: 'milestone', title: m.title, status: m.done_at ? 'completed' : 'pending',
        projectId: m.project_id, projectName: projectName.get(m.project_id) ?? null,
        ownerRequired: Boolean(m.owner_required),
      });
    }
    for (const s of scheduleItems) {
      events.push({
        date: s.day, type: s.kind === 'review' ? 'review' : 'schedule', title: s.title, status: s.done ? 'completed' : 'pending',
        projectId: s.project_id, projectName: s.projectName, ownerRequired: Boolean(s.owner_required),
      });
    }

    const audit = agents
      .filter((a) => a.active)
      .map((a) => {
        const tok = agentDayTokens.get(a.id) ?? { tokens: 0, waste: 0, projects: new Set<string>() };
        const advances = advancesByAgent.get(a.id)?.size ?? 0;
        const stalled = [...tok.projects].filter((pid) => projectStuck.get(pid)).reduce((sum, pid) => {
          return sum + tokens.filter((t) => t.agent === a.id && t.day === day && t.project_id === pid)
            .reduce((s, t) => s + (Number(t.tokens_in) || 0) + (Number(t.tokens_out) || 0), 0);
        }, 0);
        const hasLog = logs.some((l) => l.agent === a.id && l.day === day);
        const flags: string[] = [];
        if (!hasLog && tok.tokens > 0) flags.push('no_log');
        if (tok.tokens > 0 && advances === 0) flags.push('spend_no_progress');
        if (tok.waste > 0) flags.push('declared_waste');
        if (stalled > 0) flags.push('spend_on_stalled');
        return {
          agent: a.id, name: a.display_name, tokens: tok.tokens, waste: tok.waste,
          wasteRate: tok.tokens ? Math.round((tok.waste / tok.tokens) * 1000) / 1000 : 0,
          reports: reportsToday.get(a.id) ?? 0, advances, stalledTokens: stalled,
          hasLog, flags,
        };
      })
      .filter((r) => r.tokens > 0 || r.reports > 0 || r.hasLog)
      .sort((a, b) => b.tokens - a.tokens);

    const history: Array<{ day: string; tokens: number; waste: number; advances: number; reports: number; completed: number }> = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = addDays(day, -i);
      const t = tokensByDay.get(d) ?? { tokens: 0, waste: 0 };
      history.push({
        day: d,
        tokens: t.tokens,
        waste: t.waste,
        advances: reports.filter((r) => r.day === d && r.outcome === 'advanced').length,
        reports: reports.filter((r) => r.day === d).length,
        completed: (completedByDay.get(d) ?? []).length,
      });
    }

    const todayReports = reports.filter((r) => localDay(r.created_at) === day);

    return json(res, 200, {
      day,
      generatedAt: new Date().toISOString(),
      viewer: who,
      agents,
      products: productSummaries,
      projects: projected,
      tasks: tasks.map((t) => ({
        ...t,
        projectName: projectName.get(t.project_id) ?? null,
        productId: projectProduct.get(t.project_id) ?? null,
        assigneeName: t.assignee_agent ? agentName.get(t.assignee_agent) ?? t.assignee_agent : null,
      })),
      schedule: scheduleItems,
      calendar: Object.fromEntries(calendar),
      completedByDay: Object.fromEntries(completedByDay),
      events,
      reports: reports.slice(0, 300),
      feed: todayReports.slice(0, 60),
      logs: logs.filter((l) => l.day === day),
      logHistory: logs,
      tokens: {
        byAgent: [...tokensByAgent.entries()].map(([agent, value]) => ({ agent, name: agentName.get(agent) ?? agent, tokens: value })),
        byProject: [...tokensByProject.entries()].map(([projectId, value]) => ({
          projectId, name: projectName.get(projectId) ?? '未归类', tokens: value,
        })),
        byModel: [...tokensByModel.entries()].map(([model, value]) => ({ model, tokens: value })),
        byDay: history.map((h) => ({ day: h.day, tokens: h.tokens, waste: h.waste })),
      },
      audit,
      unaudited: audit.filter((a) => a.flags.includes('no_log')),
      history,
      medians: medians.map((m) => ({ stage: m.stage, medianDays: m.median_days, samples: m.samples })),
      taskEvents,
      relay: {
        agents: desk,
        counts: {
          online: desk.filter((a) => a.online).length,
          bots: desk.filter((a) => a.kind === 'bot').length,
          relays: desk.filter((a) => a.kind === 'relay').length,
          humans: desk.filter((a) => a.kind === 'human').length,
          pending: dispatches.filter((d) => d.status === 'pending').length,
          claimed: dispatches.filter((d) => d.status === 'claimed').length,
          delivered: dispatches.filter((d) => d.status === 'delivered').length,
        },
        dispatches: dispatches.map((d) => ({
          ...d,
          targetName: agentName.get(d.target_agent) ?? d.target_agent,
          relayName: d.relay_agent ? agentName.get(d.relay_agent) ?? d.relay_agent : null,
          taskTitle: d.task_id ? tasks.find((t) => t.id === d.task_id)?.title ?? null : null,
          projectName: d.project_id ? projectName.get(d.project_id) ?? null : null,
        })),
      },
      announcements,
      attachments,
      range: { from, to },
    });
  } catch (error) {
    return json(res, 503, { error: '工作台数据读取失败。', detail: String((error as Error)?.message ?? error) });
  }
}
