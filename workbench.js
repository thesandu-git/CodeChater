const $ = (id) => document.getElementById(id);

const STAGES = [
  ['idea', '概念'],
  ['proposal', '预案'],
  ['validated', '验证'],
  ['build', '开发'],
  ['testing', '调试'],
  ['launch', '上线'],
  ['revenue', '变现'],
];
const STAGE_LABEL = Object.fromEntries(STAGES);
const STATUS_LABEL = { active: '进行中', blocked: '阻塞', paused: '暂停', done: '完成', killed: '放弃' };
const PLAN_STATUS = { draft: '草稿', validated: '已验证', approved: '已批准', rejected: '已否决', converted: '已转项目', archived: '归档' };
const AGENT_LABEL = { grokbot: 'Grokbot', codex: 'Codex', dev2: 'Dev 2', hermes: 'Hermes', openbot: 'OpenBot' };
const FLAG_LABEL = {
  no_log: '未交 log',
  spend_no_progress: '花了 token 没推进',
  declared_waste: '自报空耗',
  spend_on_stalled: '消耗在停滞项目',
};

let config = null;
let session = JSON.parse(localStorage.getItem('bridge-session') || 'null');
let view = null;
let agents = [];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number(n) || 0).toLocaleString('zh-CN');
const compact = (n) => {
  const value = Number(n) || 0;
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return fmt(value);
};
const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const timeOf = (value) => (value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');
const agentName = (id) => AGENT_LABEL[id] || agents.find((a) => a.id === id)?.display_name || id || '—';

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('控制台尚未配置 Supabase 环境变量。');
  config = await response.json();
}

async function auth(path, body) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || '登录失败。');
  return data;
}

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}`, ...extra };
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: headers(init.headers || {}) });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）。`);
  return data;
}

function setSignedIn(signedIn) {
  $('loginPanel').classList.toggle('hidden', signedIn);
  $('appPanel').classList.toggle('hidden', !signedIn);
  $('signOut').classList.toggle('hidden', !signedIn);
}

// ── 渲染 ──────────────────────────────────────────────────────────────
function kpi(label, value, sub, tone = '') {
  return `<article class="kpi ${tone}"><p class="label">${esc(label)}</p><div class="value">${value}</div><div class="sub">${sub}</div></article>`;
}

function renderKpis(data) {
  const plans = data.plans || {};
  const projects = data.projects || {};
  const today = data.today || {};
  const wasteRate = today.tokens ? today.wasteTokens / today.tokens : 0;
  const stuck = (data.stuck || []).length;
  $('kpis').innerHTML = [
    kpi('产品预案', fmt(plans.open ?? 0), `${fmt(plans.total ?? 0)} 条 · 已转项目 ${fmt(plans.converted ?? 0)}`),
    kpi('在跑项目', fmt(projects.active ?? 0), `共 ${fmt(projects.total ?? 0)} 个 · 已变现 ${fmt(projects.monetized ?? 0)}`, 'accent'),
    kpi('卡住的项目', fmt(stuck), stuck ? '需要有人解锁' : '没有停滞', stuck ? 'warn' : 'good'),
    kpi('今日推进', fmt(today.advances ?? 0), `${fmt(today.reports ?? 0)} 条汇报`, (today.advances ?? 0) > 0 ? 'good' : ''),
    kpi('今日 token', compact(today.tokens ?? 0), `覆盖 ${fmt(today.projectsTouched ?? 0)} 个项目`),
    kpi('空耗 token', compact(today.wasteTokens ?? 0), `占 ${pct(wasteRate)}`, (today.wasteTokens ?? 0) > 0 ? 'warn' : 'good'),
    kpi('未交 log', fmt((data.unaudited || []).length), '今天还没交 Agent log', (data.unaudited || []).length ? 'warn' : 'good'),
  ].join('');
}

function projectCard(project) {
  const stuck = project.isStuck ? ' stuck' : '';
  const eta = project.etaDays === null || project.etaDays === undefined
    ? (project.stage === 'revenue' ? '已变现' : '剩余时间：样本不足')
    : `预计还有 ${project.etaDays} 天到变现`;
  return `<article class="pcard${stuck}" data-project="${esc(project.id)}" tabindex="0">
    <div class="pcard-top"><strong>${esc(project.name)}</strong>${project.isStuck ? '<span class="chip blocked">卡住</span>' : ''}</div>
    <div class="meta">
      <span class="chip agent">${esc(agentName(project.owner))}</span>
      <span class="chip">本阶段 ${fmt(project.daysInStage)} 天</span>
      <span class="chip">${fmt(project.daysSinceProgress)} 天未推进</span>
    </div>
    ${project.lastReport ? `<p class="last">${esc(project.lastReport)}</p>` : ''}
    <div class="eta">${esc(eta)}</div>
  </article>`;
}

function renderBoard(data) {
  const projects = data.projects?.items || [];
  const byStage = new Map(STAGES.map(([stage]) => [stage, []]));
  projects.forEach((project) => {
    if (!byStage.has(project.stage)) byStage.set(project.stage, []);
    byStage.get(project.stage).push(project);
  });
  $('board').innerHTML = STAGES.map(([stage, label]) => {
    const items = byStage.get(stage) || [];
    return `<div class="col"><div class="col-head"><strong>${label}</strong><span>${items.length}</span></div>
      ${items.map(projectCard).join('') || '<div class="empty">空</div>'}</div>`;
  }).join('');
  $('boardMeta').textContent = `${projects.length} 个项目`;
  $('board').querySelectorAll('[data-project]').forEach((node) => {
    node.addEventListener('click', () => openProject(node.dataset.project));
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openProject(node.dataset.project);
    });
  });
}

function renderStuck(data) {
  const items = data.stuck || [];
  $('stuckMeta').textContent = items.length ? `${items.length} 个` : '全部在动';
  $('stuckList').innerHTML = items.length
    ? items.map((item) => `<article class="stuck-item">
        <strong>${esc(item.name)}</strong>
        <p>${esc(item.blockedReason || item.lastReport || '没有汇报')}</p>
        <div class="row"><span>${esc(STAGE_LABEL[item.stage] || item.stage)} · ${STATUS_LABEL[item.status] || item.status}</span><span>${fmt(item.daysSinceProgress)} 天没动</span></div>
        ${item.blockerOwner ? `<div class="row"><span>等：${esc(item.blockerOwner)}</span><span>${esc(agentName(item.lastAgent))}</span></div>` : ''}
      </article>`).join('')
    : '<div class="empty">没有卡住的项目。</div>';
}

function renderFunnel(data) {
  const funnel = data.funnel || {};
  const peak = Math.max(1, ...STAGES.map(([stage]) => Number(funnel[stage]) || 0));
  $('funnel').innerHTML = STAGES.map(([stage, label], index) => {
    const count = Number(funnel[stage]) || 0;
    const width = count ? Math.max(4, Math.round((count / peak) * 100)) : 0;
    return `<div class="stage-row${index === STAGES.length - 1 ? ' final' : ''}">
      <span>${label}</span><span class="bar"><i style="width:${width}%"></i></span><span>${count}</span></div>`;
  }).join('');

  const medians = data.medians || [];
  const known = new Map(medians.map((row) => [row.stage, row]));
  const measured = STAGES.filter(([stage]) => known.get(stage));
  $('medians').innerHTML = measured.length
    ? measured.map(([stage, label]) => {
        const row = known.get(stage);
        return `<div class="median-row"><span>${label}</span><b>${row.medianDays} 天 · ${row.samples} 次</b></div>`;
      }).join('')
    : '<div class="median-row"><span>还没有阶段迁移记录</span><b>记录几次阶段变化后出现</b></div>';

  const notes = [];
  const missing = STAGES.filter(([stage]) => !known.get(stage)).map(([, label]) => label);
  if (missing.length) notes.push(`估算还缺这些阶段的真实耗时：${missing.join('、')}。样本够了才会给出“还有几天”。`);
  const stuckSpend = (data.audit || []).reduce((sum, row) => sum + (Number(row.stalledTokens) || 0), 0);
  if (stuckSpend > 0) notes.push(`今天有 ${compact(stuckSpend)} token 花在停滞项目上。`);
  notes.push('阶段中位数只统计真正迁出过的阶段；样本少于 2 次不参与估算。');
  $('funnelNotes').innerHTML = notes.map((note) => `<p>${esc(note)}</p>`).join('');
}

function renderFeed(data) {
  const items = data.feed || [];
  $('feedMeta').textContent = `${items.length} 条`;
  $('feed').innerHTML = items.length
    ? items.map((item) => `<article class="feed-item ${esc(item.kind === 'blocker' ? 'blocker' : item.outcome)}">
        <div class="head"><b>${esc(agentName(item.agent))}</b><span>${esc(item.project || '全局')}</span><span>${esc(timeOf(item.createdAt))}</span></div>
        <p>${esc(item.summary)}</p>
        ${item.detail ? `<small>${esc(item.detail)}</small>` : ''}
        ${item.blocked ? `<small>阻塞${item.blockerOwner ? ` · 等 ${esc(item.blockerOwner)}` : ''}</small>` : ''}
      </article>`).join('')
    : '<div class="empty">今天还没有汇报。</div>';
}

function renderTrend(data) {
  const history = data.history || [];
  const tokenSeries = history.map((row) => Number(row.tokens) || 0);
  const advanceSeries = history.map((row) => Number(row.advances) || 0);
  const peak = Math.max(1, ...tokenSeries);
  const width = 320;
  const height = 90;
  const step = history.length > 1 ? width / (history.length - 1) : width;
  const points = tokenSeries.map((value, index) => `${Math.round(index * step)},${Math.round(height - (value / peak) * (height - 12) - 4)}`).join(' ');
  const bars = history.map((row, index) => {
    const barHeight = Math.min(height - 8, (Number(row.advances) || 0) * 12);
    return `<rect x="${Math.round(index * step) - 4}" y="${height - barHeight}" width="8" height="${barHeight}" rx="2" fill="#c8d4f7" />`;
  }).join('');
  $('trend').innerHTML = history.length
    ? `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="7 日 token 与推进趋势">
        ${bars}
        <polyline points="${points}" fill="none" stroke="#435bda" stroke-width="2" stroke-linejoin="round" />
      </svg>
      <div class="trend-legend"><span><i style="background:#435bda"></i>token</span><span><i style="background:#c8d4f7"></i>推进的项目</span><span>${esc(history[0]?.day ?? '')} → ${esc(history[history.length - 1]?.day ?? '')}</span></div>`
    : '<div class="empty">暂无历史。</div>';
}

function renderAgents(data) {
  const rows = data.audit || [];
  $('tokenMeta').textContent = rows.length ? `合计 ${compact(rows.reduce((s, r) => s + (Number(r.tokensTotal) || 0), 0))} token` : '今天还没有记账';
  if (!rows.length) {
    $('agentTable').innerHTML = '<div class="empty">今天没有 bot 上报 token。等各 bot 通过 /api/workbench/tokens 记账。</div>';
  } else {
    $('agentTable').innerHTML = `<table><thead><tr>
      <th>Bot</th><th class="num">输入</th><th class="num">输出</th><th class="num">合计</th>
      <th class="num">空耗</th><th>空耗率</th><th class="num">推进</th><th>标记</th></tr></thead><tbody>
      ${rows.map((row) => {
        const flagged = (row.flags || []).filter((flag) => flag !== 'declared_waste');
        return `<tr class="${flagged.length ? 'flag' : ''}">
          <td><b>${esc(row.name || agentName(row.agent))}</b></td>
          <td class="num">${compact(row.tokensIn)}</td>
          <td class="num">${compact(row.tokensOut ?? 0)}</td>
          <td class="num">${compact(row.tokensTotal)}</td>
          <td class="num">${compact(row.wasteTokens)}</td>
          <td><span class="rate"><i><b style="width:${Math.round((Number(row.wasteRate) || 0) * 100)}%"></b></i>${pct(row.wasteRate)}</span></td>
          <td class="num">${fmt(row.advances)}</td>
          <td>${(row.flags || []).map((flag) => `<span class="tag ${flag === 'no_log' || flag === 'spend_on_stalled' ? 'bad' : 'warn'}">${esc(FLAG_LABEL[flag] || flag)}</span>`).join('') || '—'}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
  }

  const missing = data.unaudited || [];
  $('unaudited').classList.toggle('hidden', !missing.length);
  $('unaudited').innerHTML = missing.length
    ? `还没交 Agent log：${missing.map((row) => esc(row.name || agentName(row.agent))).join('、')}。每天结束后每个 bot 必须交一份，否则 token 无法对账。`
    : '';
}

function renderParticipation(data) {
  const rows = data.participation || [];
  $('participation').innerHTML = rows.length
    ? `<table><thead><tr><th>项目</th><th>Bot</th><th class="num">token</th><th class="num">汇报</th><th>最后一次</th></tr></thead><tbody>
      ${rows.map((row) => `<tr><td>${esc(row.project || '未归类')}</td><td>${esc(agentName(row.agent))}</td>
        <td class="num">${compact(row.tokens)}</td><td class="num">${fmt(row.reports)}</td><td>${esc(timeOf(row.lastAt))}</td></tr>`).join('')}
      </tbody></table>`
    : '<div class="empty">近 7 天没有按项目记账的数据。</div>';
}

function renderLogs(data) {
  const logs = data.logs || [];
  $('logMeta').textContent = logs.length ? `${logs.length} 份` : '今天还没有';
  $('logs').innerHTML = logs.length
    ? logs.map((log) => `<article class="log-card">
        <header><b>${esc(agentName(log.agent))}</b><span>${esc(log.day)} · ${compact(log.tokensTotal)} token · 空耗 ${compact(log.wasteTokens)}</span></header>
        <pre>${esc(log.markdown)}</pre>
        <div class="foot">${log.tasksDone !== null ? `完成 ${fmt(log.tasksDone)} 个任务 · ` : ''}${log.tasksFailed !== null ? `失败 ${fmt(log.tasksFailed)} 个 · ` : ''}${esc((log.projects || []).join('、'))}</div>
      </article>`).join('')
    : '<div class="empty">今天还没有 Agent log。</div>';
}

function render(data) {
  view = data;
  const day = data.day || '';
  $('dayInput').value = day;
  $('dayLabel').textContent = day === new Date().toLocaleDateString('sv-SE') ? `今天 · ${day}` : `查看 ${day}`;
  renderKpis(data);
  renderBoard(data);
  renderStuck(data);
  renderFunnel(data);
  renderFeed(data);
  renderTrend(data);
  renderAgents(data);
  renderParticipation(data);
  renderLogs(data);
}

async function load(day) {
  const query = day ? `?day=${encodeURIComponent(day)}` : '';
  const data = await api(`/api/workbench/overview${query}`);
  render(data);
  if (!agents.length) {
    agents = (await api('/api/workbench/agents').catch(() => [])) || [];
  }
}

// ── 弹窗与写入 ────────────────────────────────────────────────────────
function openModal(title, html) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalError').textContent = '';
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
}

function agentOptions(selected) {
  return agents.map((agent) => `<option value="${esc(agent.id)}"${agent.id === selected ? ' selected' : ''}>${esc(agent.display_name)}</option>`).join('');
}

function openNewPlan() {
  openModal('新建产品预案', `<form id="planForm">
    <label>预案标题<input name="title" maxlength="180" required placeholder="例如：科伦坡小商户的拼单工具" /></label>
    <label>一句话说明<textarea name="summary" maxlength="6000" placeholder="谁用、解决什么、怎么收钱"></textarea></label>
    <div class="row2">
      <label>提出者<select name="source_agent">${agentOptions('grokbot')}</select></label>
      <label>目标用户<input name="target_user" maxlength="240" placeholder="例如：本地小商户" /></label>
    </div>
    <label>价格假设（当地货币）<input name="price_hypothesis" type="number" min="0" step="1" placeholder="例如 1500" /></label>
    <button class="primary" type="submit">保存预案</button>
    <p class="hint">预案不会自动变成项目；转项目时选它即可。</p>
  </form>`);
  $('planForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      await api('/api/workbench/plans', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      await load($('dayInput').value);
    } catch (error) {
      $('modalError').textContent = error.message;
    }
  });
}

function openNewProject() {
  const plans = (view?.plans?.items || []).filter((plan) => plan.status !== 'converted');
  openModal('新建项目', `<form id="projectForm">
    <label>项目名<input name="name" maxlength="180" required placeholder="例如：Prasad Shelf" /></label>
    <div class="row2">
      <label>阶段<select name="stage">${STAGES.map(([key, label]) => `<option value="${key}"${key === 'idea' ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>负责 bot<select name="owner_agent">${agentOptions('dev2')}</select></label>
    </div>
    <label>关联预案<select name="plan_id"><option value="">不关联</option>${plans.map((plan) => `<option value="${esc(plan.id)}">${esc(plan.title)}</option>`).join('')}</select></label>
    <label>项目说明<textarea name="summary" maxlength="6000" placeholder="做什么、给谁、现在的状态"></textarea></label>
    <div class="row2">
      <label>仓库<input name="repo_url" maxlength="500" placeholder="https://github.com/..." /></label>
      <label>预览地址<input name="preview_url" maxlength="500" placeholder="https://...vercel.app" /></label>
    </div>
    <button class="primary" type="submit">创建项目</button>
  </form>`);
  $('projectForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      await api('/api/workbench/projects', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      await load($('dayInput').value);
    } catch (error) {
      $('modalError').textContent = error.message;
    }
  });
}

function openProject(id) {
  const project = (view?.projects?.items || []).find((item) => item.id === id);
  if (!project) return;
  openModal(project.name, `<form id="editForm">
    <div class="row2">
      <label>阶段<select name="stage">${STAGES.map(([key, label]) => `<option value="${key}"${key === project.stage ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>状态<select name="status">${Object.entries(STATUS_LABEL).map(([key, label]) => `<option value="${key}"${key === project.status ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <label>说明<input name="progress_note" maxlength="240" placeholder="这次改了什么（写进阶段历史）" /></label>
    <label>卡在哪 / 等谁<input name="blocked_reason" maxlength="240" value="${esc(project.blockedReason || '')}" placeholder="例如：等客服报价" /></label>
    <label>卡点负责人<input name="blocker_owner" maxlength="120" value="${esc(project.blockerOwner || '')}" placeholder="例如：Prasad" /></label>
    <div class="row2">
      <label>变现方式<input name="monetization_model" maxlength="240" value="${esc(project.monetizationModel || '')}" placeholder="例如：每单抽成" /></label>
      <label>月收入<input name="monthly_revenue" type="number" min="0" step="1" value="${esc(project.monthlyRevenue ?? 0)}" /></label>
    </div>
    <label>摘要<textarea name="summary" maxlength="6000">${esc(project.summary || '')}</textarea></label>
    <button class="primary" type="submit">保存</button>
    <p class="hint">改阶段会写一条阶段历史，用于计算“还剩几天到变现”。</p>
  </form>`);
  $('editForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      await api(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeModal();
      await load($('dayInput').value);
    } catch (error) {
      $('modalError').textContent = error.message;
    }
  });
}

// ── 事件 ──────────────────────────────────────────────────────────────
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    const result = await auth('token?grant_type=password', { email: $('email').value, password: $('password').value });
    session = result;
    localStorage.setItem('bridge-session', JSON.stringify(session));
    setSignedIn(true);
    await load();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});

$('signOut').addEventListener('click', async () => {
  try {
    await fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${session?.access_token ?? ''}` } });
  } catch {}
  localStorage.removeItem('bridge-session');
  session = null;
  setSignedIn(false);
});

$('refresh').addEventListener('click', () => {
  load($('dayInput').value).catch((error) => {
    $('loginError').textContent = error.message;
  });
});
$('dayInput').addEventListener('change', () => load($('dayInput').value).catch(() => {}));
$('newPlanBtn').addEventListener('click', openNewPlan);
$('newProjectBtn').addEventListener('click', openNewProject);
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

(async () => {
  try {
    await loadConfig();
  } catch (error) {
    $('loginError').textContent = error.message;
    return;
  }
  if (session?.access_token) {
    setSignedIn(true);
    try {
      await load();
    } catch {
      localStorage.removeItem('bridge-session');
      session = null;
      setSignedIn(false);
    }
    setInterval(() => {
      if (session && $('modal').classList.contains('hidden')) load($('dayInput').value).catch(() => {});
    }, 30000);
  }
})();
