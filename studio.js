/* Studio 前端 —— 四层：产品与进度 / Kanban / 日历时间线 / Agent Log */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number(n) || 0).toLocaleString('zh-CN');
const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return fmt(v);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const STAGES = [['idea', '概念'], ['proposal', '预案'], ['validated', '验证'], ['build', '开发'], ['testing', '调试'], ['launch', '上线'], ['revenue', '变现']];
const STAGE_LABEL = Object.fromEntries(STAGES);
const PROJECT_STATUS = {
  not_started: '未启动', active: '执行', blocked: '执行 · 受阻', paused: '暂停',
  done: '完成', killed: '取消', cancelled: '取消',
};
const BUCKETS = [
  ['active', '执行', ['active', 'blocked']],
  ['done', '完成', ['done']],
  ['killed', '取消', ['killed', 'cancelled']],
  ['paused', '暂停', ['paused']],
  ['not_started', '未启动', ['not_started']],
];
const TASK_STATUS = { on_track: '正常推进', at_risk: '有风险', blocked: '受阻', completed: '完成', on_hold: '暂停' };
const TASK_ORDER = ['on_track', 'at_risk', 'blocked', 'completed', 'on_hold'];
const PRIORITY = { high: '高', medium: '中', low: '低' };
const FLAG = { no_log: '未交 log', spend_no_progress: '花了没推进', declared_waste: '自报空耗', spend_on_stalled: '耗在停滞项目' };

let config = null;
let session = JSON.parse(localStorage.getItem('bridge-session') || 'null');
const state = { view: null, tab: 'products', product: null, month: null, calMode: 'calendar' };
let justDragged = false;
let dragTaskId = null;

const agentName = (id) => (state.view?.agents || []).find((a) => a.id === id)?.display_name || id || '—';
const shortDate = (d) => (d ? d.slice(5).replace('-', '/') : '—');
const dayLabel = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
const todayIso = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function loadConfig() {
  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) throw new Error('控制台尚未配置 Supabase 环境变量。');
  config = await res.json();
}

function authHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}`, ...extra };
}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: authHeaders(init.headers || {}) });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

async function signIn(email, password) {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || '登录失败');
  return data;
}

async function load() {
  const day = $('dayInput').value || '';
  const data = await api(`/api/studio/state${day ? `?day=${encodeURIComponent(day)}` : ''}`);
  state.view = data;
  if (!state.month) state.month = (data.day || todayIso()).slice(0, 7);
  $('dayInput').value = data.day;
  $('bootError').classList.add('hidden');
  renderAll();
}

function guard(fn) {
  return async (...args) => {
    try { await fn(...args); } catch (error) {
      const box = $('bootError');
      box.textContent = error.message;
      box.classList.remove('hidden');
      setTimeout(() => box.classList.add('hidden'), 6000);
    }
  };
}

// ── 通用片段 ───────────────────────────────────────────────
function donut(pct, muted) {
  const value = clamp(Math.round(Number(pct) || 0), 0, 100);
  const c = 2 * Math.PI * 24;
  const color = muted ? '#a9761b' : (value >= 70 ? '#0f4f34' : '#1d7a4a');
  return `<div class="donut ${muted ? 'warn' : ''}"><svg width="58" height="58" viewBox="0 0 58 58">
      <circle cx="29" cy="29" r="24" fill="none" stroke="#e6f1e9" stroke-width="7"/>
      <circle cx="29" cy="29" r="24" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - value / 100)).toFixed(1)}"/>
    </svg><span class="pct">${value}%</span></div>`;
}

function barRow(label, value, max, suffix) {
  const pctWidth = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="bar-row"><span class="nm" title="${esc(label)}">${esc(label)}</span>
    <span class="track"><i style="width:${pctWidth}%"></i></span>
    <span class="v">${esc(suffix ?? compact(value))}</span></div>`;
}

function etaText(p) {
  if (p.stage === 'revenue' || p.status === 'done') return '已变现';
  if (p.etaDays === 0) return '已变现';
  if (p.etaDays === null || p.etaDays === undefined) return '样本不足';
  return `约 ${p.etaDays} 天`;
}

// ── 一级：产品 ─────────────────────────────────────────────
function renderPrails() {
  const list = state.view.products || [];
  $('prailList').innerHTML = list.map((p) => `
    <div class="prail-item ${state.product === p.id ? 'is-active' : ''}" data-product="${esc(p.id)}">
      <span class="prail-dot" style="background:${p.stuckProjects ? '#a9761b' : '#1d7a4a'}"></span>
      <div class="prail-body">
        <div class="prail-name">${esc(p.name)}</div>
        <div class="prail-detail">${p.liveProjects} 个项目${p.stuckProjects ? ` · ${p.stuckProjects} 卡住` : ''}</div>
        <div class="prail-eta">到变现：${p.etaDays === null ? '样本不足' : p.etaDays === 0 ? '已变现' : `约 ${p.etaDays} 天`}</div>
      </div>
    </div>`).join('') || '<div class="empty">还没有产品</div>';
  $('prailList').querySelectorAll('[data-product]').forEach((node) => {
    node.addEventListener('click', () => {
      state.product = state.product === node.dataset.product ? null : node.dataset.product;
      renderAll();
    });
  });
}

function renderProducts() {
  const products = state.view.products || [];
  const projects = filteredProjects();
  $('productMeta').textContent = `${products.length} 个产品 · ${projects.length} 个项目在视图内`;
  $('productStrip').innerHTML = products.map((p) => `
    <article class="ptile ${state.product === p.id ? 'is-selected' : ''} ${p.stuckProjects ? 'warn' : ''}" data-product="${esc(p.id)}">
      ${donut(p.progressPct, p.stuckProjects > 0)}
      <div class="ptile-main">
        <div class="ptile-name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="ptile-stage">${esc(STAGE_LABEL[p.stage] || p.stage)} · ${p.liveProjects} 个项目</div>
        <div class="ptile-meta">${p.etaDays === null ? '到变现：样本不足' : `到变现：${p.etaDays === 0 ? '已变现' : `约 ${p.etaDays} 天`}`}</div>
        <div class="ptile-extra">
          <div>完成 ${p.doneProjects} · 卡住 ${p.stuckProjects}</div>
          <div>${esc(p.monetization_model || '未写变现方式')}</div>
          <div>${esc(p.target_user || '未写目标用户')}</div>
        </div>
      </div>
    </article>`).join('') || '<div class="empty">先建一个产品：右上角「+ 产品」。</div>';

  $('productStrip').querySelectorAll('[data-product]').forEach((node) => {
    node.addEventListener('click', () => {
      state.product = node.dataset.product;
      renderAll();
      openProduct(node.dataset.product);
    });
  });
}

function filteredProjects() {
  let list = state.view.projects || [];
  if (state.product) list = list.filter((p) => p.product_id === state.product);
  return list;
}

function renderBuckets() {
  const projects = filteredProjects();
  const active = projects.filter((p) => !['killed', 'cancelled'].includes(p.status));
  $('bucketMeta').textContent = `${projects.length} 个项目${state.product ? ` · 只看 ${esc((state.view.products.find((x) => x.id === state.product) || {}).name || '')}` : ''} · ${active.length} 个未取消`;
  $('buckets').innerHTML = BUCKETS.map(([key, label, statuses]) => {
    const items = projects.filter((p) => statuses.includes(p.status));
    return `<div class="bucket" data-status="${key}">
      <div class="bucket-head"><strong><span class="pip"></span>${label}</strong><span class="n">${items.length}</span></div>
      ${items.map(projectCard).join('') || '<div class="empty">空</div>'}
    </div>`;
  }).join('');
  $('buckets').querySelectorAll('[data-project]').forEach((node) => {
    node.addEventListener('click', () => openProject(node.dataset.project));
  });
}

function projectCard(p) {
  const chips = [
    `<span class="chip green">${esc(STAGE_LABEL[p.stage] || p.stage)}</span>`,
    p.owner_agent ? `<span class="chip navy">${esc(agentName(p.owner_agent))}</span>` : '',
    p.is_stuck ? `<span class="chip amber">${p.days_since_progress ?? 0} 天没推进</span>` : '',
    p.task_blocked ? `<span class="chip red">${p.task_blocked} 任务卡住</span>` : '',
    p.etaDays === null ? '<span class="chip">样本不足</span>' : `<span class="chip">${p.etaDays === 0 ? '已变现' : p.etaDays + ' 天到变现'}</span>`,
  ].filter(Boolean).join('');
  return `<article class="pcard ${p.is_stuck ? 'stuck' : ''}" data-project="${esc(p.id)}" tabindex="0">
    <div class="pcard-name">${esc(p.name)}</div>
    ${p.productName && p.productName !== p.name ? `<div class="pcard-prod">${esc(p.productName)}</div>` : ''}
    ${p.summary ? `<p class="pcard-sum">${esc(p.summary)}</p>` : ''}
    <div class="pbar"><i style="width:${clamp(p.progressPct, 0, 100)}%"></i></div>
    <div class="pbar-row"><span>${p.taskDone}/${p.taskCount} 任务</span><span>${p.progressPct}%</span></div>
    <div class="pcard-chips">${chips}</div>
  </article>`;
}

// ── 产品 / 项目弹窗 ────────────────────────────────────────
function openSheet(title, html) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalError').textContent = '';
  $('overlay').classList.remove('hidden');
}
function closeSheet() {
  $('overlay').classList.add('hidden');
}

function openProduct(id) {
  const p = (state.view.products || []).find((x) => x.id === id);
  if (!p) return;
  const projects = (state.view.projects || []).filter((x) => x.product_id === id);
  const docs = p.docs || [];
  openSheet(p.name, `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">离变现</div><div class="v">${p.etaDays === null ? '样本不足' : p.etaDays === 0 ? '已变现' : `约 ${p.etaDays} 天`}</div></div>
      <div class="meta-box"><div class="k">产品进度</div><div class="v">${p.progressPct}%</div></div>
      <div class="meta-box"><div class="k">项目</div><div class="v">${p.liveProjects} 在跑 / ${p.projectCount} 总</div></div>
      <div class="meta-box"><div class="k">变现方式</div><div class="v">${esc(p.monetization_model || '未填')}</div></div>
    </div>
    <div class="block"><h4>产品综述</h4><p>${esc(p.summary || '未填写')}</p></div>
    <div class="block"><h4>产品规划</h4><p>${esc(p.plan || '未填写')}</p></div>
    <div class="block"><h4>产品内项目</h4>
      ${projects.map((x) => `<div class="task-row"><span>${esc(x.name)}</span><span class="chip green">${esc(STAGE_LABEL[x.stage] || x.stage)}</span>
        <span class="sp"></span><span class="st ${x.status}">${esc(PROJECT_STATUS[x.status] || x.status)}</span>
        <span style="color:#6b8092">${x.progressPct}%</span></div>`).join('') || '<p class="hint">还没有项目挂到这个产品下。</p>'}
    </div>
    <div class="block"><h4>产品调研汇报</h4>
      ${docs.length ? docs.map((d) => `<a class="doc-link" href="${esc(d.url || '#')}" target="_blank" rel="noopener">
        <span>${esc(d.title)}</span><span class="chip">${esc(d.kind)}</span></a>`).join('') : `<p>${esc(p.research || '还没有研究文档。')}</p>`}
    </div>
    <details class="block"><summary class="hint">编辑产品</summary>
      <form class="stack" id="productEdit" style="margin-top:10px">
        <label>名称<input name="name" maxlength="180" value="${esc(p.name)}" required /></label>
        <label>综述<textarea name="summary" maxlength="8000">${esc(p.summary || '')}</textarea></label>
        <label>规划<textarea name="plan" maxlength="8000">${esc(p.plan || '')}</textarea></label>
        <label>调研汇报<textarea name="research" maxlength="12000">${esc(p.research || '')}</textarea></label>
        <div class="row2">
          <label>目标用户<input name="target_user" maxlength="240" value="${esc(p.target_user || '')}" /></label>
          <label>变现方式<input name="monetization_model" maxlength="240" value="${esc(p.monetization_model || '')}" /></label>
        </div>
        <button class="primary" type="submit">保存产品</button>
      </form>
    </details>`);
  $('productEdit')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/studio/products?id=${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function ganttSvg(project) {
  const W = 900, L = 168, R = 18;
  const items = [];
  (project.tasks || []).forEach((t) => {
    if (!t.start_at && !t.due_at) return;
    const end = t.due_at || t.start_at;
    let start = t.start_at || end;
    // 只有截止日期时给两天长度，否则条形会缩成一个点
    if (!t.start_at && end) {
      const d = new Date(`${end}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 2);
      start = d.toISOString().slice(0, 10);
    }
    items.push({ start, end, label: t.title, kind: 'task', status: t.status, owner: t.owner_required });
  });
  (project.milestones || []).forEach((m) => items.push({
    start: m.due_at, end: m.due_at, label: m.title, kind: 'ms', status: m.done_at ? 'completed' : 'pending', owner: m.owner_required,
  }));
  if (!items.length) return '<div class="empty">这个项目还没排期：给任务加开始/截止，或加里程碑。</div>';
  const parse = (d) => new Date(`${d}T00:00:00Z`).getTime();
  let min = Math.min(...items.map((i) => parse(i.start)));
  let max = Math.max(...items.map((i) => parse(i.end)));
  if (project.started_at) min = Math.min(min, parse(project.started_at.slice(0, 10)));
  const today = parse(todayIso());
  min = Math.min(min, today - 3 * 864e5);
  max = Math.max(max, today + 7 * 864e5);
  if (max - min < 14 * 864e5) max = min + 14 * 864e5;
  const span = max - min;
  const x = (d) => L + ((parse(d) - min) / span) * (W - L - R);
  const rowH = 24, top = 26;
  const H = top + items.length * rowH + 10;
  const ticks = [];
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i += 1) {
    const t = min + (span * i) / tickCount;
    ticks.push(`<line x1="${L + ((W - L - R) * i) / tickCount}" y1="${top - 8}" x2="${L + ((W - L - R) * i) / tickCount}" y2="${H - 6}" stroke="#eef4f0" />
      <text x="${L + ((W - L - R) * i) / tickCount}" y="${top - 12}" text-anchor="middle">${new Date(t).toISOString().slice(5, 10).replace('-', '/')}</text>`);
  }
  const todayX = x(new Date(today).toISOString().slice(0, 10));
  const bars = items.map((item, idx) => {
    const y = top + idx * rowH;
    const cls = item.kind === 'ms' ? 'ms' : item.status === 'completed' ? 'bar done' : item.status === 'blocked' ? 'bar blocked' : item.status === 'at_risk' ? 'bar risk' : item.status === 'on_hold' ? 'bar hold' : 'bar';
    const x1 = x(item.start), x2 = Math.max(x1 + 6, x(item.end));
    const shape = item.kind === 'ms'
      ? `<rect x="${x1 - 5}" y="${y + 3}" width="10" height="10" class="${cls} ${item.owner ? 'owner' : ''}" transform="rotate(45 ${x1} ${y + 8})" />`
      : `<rect x="${x1}" y="${y + 2}" width="${Math.max(6, x2 - x1)}" height="12" rx="4" class="${cls}" />`;
    const ring = item.owner ? `<circle cx="${item.kind === 'ms' ? x1 : x1 + 4}" cy="${y + 8}" r="9" class="owner-ring" />` : '';
    return `<text x="6" y="${y + 12}">${esc(item.label).slice(0, 22)}</text>${shape}${ring}`;
  }).join('');
  return `<div class="gantt"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="项目甘特图">
    ${ticks.join('')}
    <line x1="${todayX}" y1="${top - 8}" x2="${todayX}" y2="${H - 6}" stroke="#1d7a4a" stroke-dasharray="3 3" />
    ${bars}
  </svg></div>`;
}

function openProject(id) {
  const p = (state.view.projects || []).find((x) => x.id === id);
  if (!p) return;
  const taskList = (p.tasks || []).filter((t) => !t.parent_id);
  const subOf = (tid) => (p.tasks || []).filter((t) => t.parent_id === tid);
  openSheet(p.name, `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">状态 / 阶段</div><div class="v">${esc(PROJECT_STATUS[p.status] || p.status)} · ${esc(STAGE_LABEL[p.stage] || p.stage)}</div></div>
      <div class="meta-box"><div class="k">进度</div><div class="v">${p.progressPct}% · ${p.taskDone}/${p.taskCount} 任务</div></div>
      <div class="meta-box"><div class="k">到变现</div><div class="v">${etaText(p)}</div></div>
      <div class="meta-box"><div class="k">负责 bot</div><div class="v">${esc(agentName(p.owner_agent))}</div></div>
    </div>
    <div class="block"><h4>参与的 bot</h4>
      <div class="pcard-chips">${(p.participants || []).map((x) => `<span class="chip navy">${esc(x.name)} · ${compact(x.tokens)} tok · ${x.reports} 汇报</span>`).join('') || '<span class="chip">暂无汇报</span>'}</div>
    </div>
    <div class="block"><h4>当前任务</h4>
      ${p.currentTask ? `<div class="task-row"><span>${esc(p.currentTask.title)}</span>
        <span class="sp"></span>
        <span class="chip navy">${esc(agentName(p.currentTask.assignee_agent))}</span>
        <span class="st ${p.currentTask.status}">${esc(TASK_STATUS[p.currentTask.status] || p.currentTask.status)}</span>
        ${p.currentTask.owner_required ? '<span class="chip owner">你要做</span>' : ''}</div>`
        : '<p class="hint">没有未完成任务。</p>'}
    </div>
    <div class="block"><h4>任务甘特 · 里程碑</h4>${ganttSvg(p)}</div>
    <div class="block"><h4>项目分类 / 目的</h4><p>${esc(p.category || '未分类')} · ${esc(p.purpose || '未写目的')}</p></div>
    <div class="block"><h4>项目规划</h4><p>${esc(p.plan || '未填写')}</p></div>
    <div class="block"><h4>项目综述</h4><p>${esc(p.summary || '未填写')}</p></div>
    <div class="block"><h4>研究文档</h4>
      ${(p.docs || []).length ? (p.docs || []).map((d) => `<a class="doc-link" href="${esc(d.url || '#')}" target="_blank" rel="noopener"><span>${esc(d.title)}</span><span class="chip">${esc(d.kind)}</span></a>`).join('') : '<p class="hint">还没有文档。</p>'}
    </div>
    <div class="block"><h4>任务列表</h4>
      ${taskList.map((t) => `<div class="task-row" data-task="${esc(t.id)}" style="cursor:pointer">
        <span>${esc(t.title)}</span>${t.owner_required ? '<span class="chip owner">你要做</span>' : ''}
        <span class="sp"></span>
        <span class="chip">${esc(agentName(t.assignee_agent))}</span>
        <span class="st ${t.status}">${esc(TASK_STATUS[t.status] || t.status)}</span>
        ${subOf(t.id).length ? `<span class="chip">${subOf(t.id).length} 子任务</span>` : ''}</div>`).join('') || '<p class="hint">还没有任务。</p>'}
    </div>
    <div class="block"><h4>调整状态</h4>
      <form class="stack" id="projectEdit">
        <div class="row3">
          <label>状态<select name="status">${Object.entries(PROJECT_STATUS).map(([k, v]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>阶段<select name="stage">${STAGES.map(([k, v]) => `<option value="${k}" ${k === p.stage ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>进度 %<input name="progress" type="number" min="0" max="100" value="${p.progressPct}" /></label>
        </div>
        <label>说明（写进阶段历史）<input name="progress_note" maxlength="240" /></label>
        <div class="row2">
          <label>卡在哪<input name="blocked_reason" maxlength="240" value="${esc(p.blocked_reason || '')}" /></label>
          <label>等谁<input name="blocker_owner" maxlength="120" value="${esc(p.blocker_owner || '')}" /></label>
        </div>
        <div class="row2">
          <button class="primary" type="submit">保存</button>
          <div style="display:flex;gap:8px;align-items:center">
            ${p.repo_url ? `<a class="ghost small" href="${esc(p.repo_url)}" target="_blank" rel="noopener">打开仓库</a>` : ''}
            ${p.preview_url ? `<a class="ghost small" href="${esc(p.preview_url)}" target="_blank" rel="noopener">打开预览</a>` : ''}
          </div>
        </div>
      </form>
    </div>`);
  $('projectEdit')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/studio/projects?id=${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
  $('modalBody').querySelectorAll('[data-task]').forEach((node) => {
    node.addEventListener('click', () => openTask(node.dataset.task));
  });
}

// ── 任务弹窗 ───────────────────────────────────────────────
function openTask(id) {
  const t = (state.view.tasks || []).find((x) => x.id === id);
  if (!t) return;
  const subs = (state.view.tasks || []).filter((x) => x.parent_id === id);
  openSheet(t.title, `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">项目</div><div class="v">${esc(t.projectName || '—')}</div></div>
      <div class="meta-box"><div class="k">接手 AI</div><div class="v">${esc(agentName(t.assignee_agent))}</div></div>
      <div class="meta-box"><div class="k">状态</div><div class="v">${esc(TASK_STATUS[t.status] || t.status)}</div></div>
      <div class="meta-box"><div class="k">截止</div><div class="v">${esc(t.due_at || '未设置')}</div></div>
    </div>
    <form class="stack" id="taskEdit">
      <label>任务标题<input name="title" maxlength="200" value="${esc(t.title)}" required /></label>
      <label>任务规划<textarea name="plan" maxlength="8000" placeholder="步骤、验收标准、不要做什么">${esc(t.plan || '')}</textarea></label>
      <div class="row3">
        <label>状态<select name="status">${TASK_ORDER.map((k) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${TASK_STATUS[k]}</option>`).join('')}</select></label>
        <label>优先级<select name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${k === t.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>接手 bot<select name="assignee_agent"><option value="">未指派</option>${(state.view.agents || []).map((a) => `<option value="${esc(a.id)}" ${a.id === t.assignee_agent ? 'selected' : ''}>${esc(a.display_name)}</option>`).join('')}</select></label>
      </div>
      <div class="row3">
        <label>开始<input name="start_at" type="date" value="${esc(t.start_at || '')}" /></label>
        <label>截止<input name="due_at" type="date" value="${esc(t.due_at || '')}" /></label>
        <label>进度 %<input name="progress" type="number" min="0" max="100" value="${t.progress ?? 0}" /></label>
      </div>
      <label>受阻原因<input name="blocked_reason" maxlength="400" value="${esc(t.blocked_reason || '')}" /></label>
      <label class="checkline"><input type="checkbox" name="owner_required" ${t.owner_required ? 'checked' : ''} /> 需要主人亲手执行 / 把关</label>
      <button class="primary" type="submit">保存任务</button>
    </form>
    <div class="block"><h4>子任务</h4>
      ${subs.map((s) => `<div class="task-row"><span>${esc(s.title)}</span><span class="sp"></span>
        <span class="st ${s.status}">${esc(TASK_STATUS[s.status] || s.status)}</span></div>`).join('') || '<p class="hint">没有子任务。</p>'}
      <form class="stack" id="subForm" style="margin-top:8px">
        <div class="row2"><input name="title" placeholder="加一个子任务" maxlength="200" required />
        <select name="assignee_agent"><option value="">谁做</option>${(state.view.agents || []).map((a) => `<option value="${esc(a.id)}">${esc(a.display_name)}</option>`).join('')}</select></div>
        <button class="ghost" type="submit">+ 子任务</button>
      </form>
    </div>
    <div class="block"><h4>交接给 AI</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="ghost" id="promptBtn">生成执行摘要 prompt</button>
        <button class="ghost" id="checkBtn">申请检查</button>
      </div>
      <pre id="promptOut" class="hint" style="white-space:pre-wrap;margin-top:10px;max-height:240px;overflow:auto"></pre>
    </div>`);

  $('taskEdit').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.owner_required = form.get('owner_required') === 'on';
    try {
      await api(`/api/studio/tasks?id=${encodeURIComponent(t.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });

  $('subForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    body.project_id = t.project_id;
    body.parent_id = t.id;
    body.status = 'on_track';
    try {
      await api('/api/studio/tasks', { method: 'POST', body: JSON.stringify(body) });
      await load();
      openTask(t.id);
    } catch (error) { $('modalError').textContent = error.message; }
  });

  $('promptBtn').addEventListener('click', async () => {
    try {
      const data = await api(`/api/studio/prompt?task=${encodeURIComponent(t.id)}`);
      $('promptOut').textContent = data.prompt;
    } catch (error) { $('modalError').textContent = error.message; }
  });

  $('checkBtn').addEventListener('click', async () => {
    const reason = prompt('卡在哪？（会标成有风险并放进你的日程）');
    if (!reason) return;
    try {
      await api('/api/studio/check', { method: 'POST', body: JSON.stringify({ task_id: t.id, reason }) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

// ── 第二层：Kanban ─────────────────────────────────────────
function renderKanban() {
  const tasks = (state.view.tasks || []).filter((t) => !state.product || t.productId === state.product);
  $('kanbanMeta').textContent = `${tasks.length} 个任务 · ${(state.view.projects || []).length} 个项目 · 拖动卡片可改状态`;
  $('kanban').innerHTML = TASK_ORDER.map((status) => {
    const items = tasks.filter((t) => t.status === status);
    return `<div class="kcol" data-status="${status}"><div class="kcol-head"><strong>${TASK_STATUS[status]}</strong><span class="n">${items.length}</span></div>
      ${items.map((t) => {
        const due = t.due_at;
        const late = due && due < todayIso() && status !== 'completed';
        const soon = due && !late && due <= new Date(Date.now() + 5.5 * 3600e3 + 3 * 864e5).toISOString().slice(0, 10);
        return `<article class="kcard s-${status}" data-task="${esc(t.id)}" draggable="true">
          <div class="kcard-title">${esc(t.title)}</div>
          <div class="kcard-proj">${esc(t.projectName || '—')}</div>
          <div class="kcard-foot">
            <span class="who">${esc(t.assigneeName || '未指派')}</span>
            <span class="${late ? 'due-late' : soon ? 'due-soon' : ''}">${due ? shortDate(due) : '无截止'}</span>
          </div>
          <div class="kcard-foot">
            <span>${t.priority === 'high' ? '<span class="chip red">高</span>' : t.priority === 'low' ? '<span class="chip">低</span>' : '<span class="chip">中</span>'}${t.owner_required ? '<span class="chip owner">你要做</span>' : ''}</span>
            <span>${(state.view.tasks || []).filter((x) => x.parent_id === t.id).length || ''}</span>
          </div>
        </article>`;
      }).join('') || '<div class="empty">空</div>'}</div>`;
  }).join('');

  $('kanban').querySelectorAll('.kcard').forEach((card) => {
    card.addEventListener('click', () => { if (!justDragged) openTask(card.dataset.task); });
    card.addEventListener('dragstart', (event) => {
      dragTaskId = card.dataset.task;
      justDragged = true;
      card.classList.add('is-dragging');
      event.dataTransfer.setData('text/plain', card.dataset.task);
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      document.querySelectorAll('.kcol').forEach((c) => c.classList.remove('drop-target'));
      setTimeout(() => { justDragged = false; }, 250);
    });
  });

  $('kanban').querySelectorAll('.kcol').forEach((col) => {
    col.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      col.classList.add('drop-target');
    });
    col.addEventListener('dragleave', (event) => {
      if (!col.contains(event.relatedTarget)) col.classList.remove('drop-target');
    });
    col.addEventListener('drop', async (event) => {
      event.preventDefault();
      col.classList.remove('drop-target');
      const id = event.dataTransfer.getData('text/plain') || dragTaskId;
      dragTaskId = null;
      if (!id) return;
      await moveTask(id, col.dataset.status);
    });
  });
}

/** 拖动改状态：先乐观更新本地面板，再写库；失败回滚并提示。 */
async function moveTask(id, status) {
  const task = (state.view.tasks || []).find((t) => t.id === id);
  if (!task || task.status === status) return;
  const previous = task.status;
  task.status = status;
  renderKanban();
  try {
    await api(`/api/studio/tasks?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note: '看板拖动' }),
    });
    await load();
  } catch (error) {
    task.status = previous;
    renderKanban();
    const box = $('bootError');
    box.textContent = `改状态失败：${error.message}`;
    box.classList.remove('hidden');
    setTimeout(() => box.classList.add('hidden'), 6000);
  }
}

// ── 第三层：日历 / 时间线 ──────────────────────────────────
function calendarItems(day) {
  const out = [];
  (state.view.calendar?.[day] || []).forEach((s) => out.push({ kind: 'schedule', item: s, title: s.title, owner: s.owner_required, done: s.done, cls: s.owner_required ? 'owner' : s.kind === 'review' ? 'review' : 'work' }));
  (state.view.tasks || []).forEach((t) => {
    if (t.due_at === day) out.push({ kind: 'task', item: t, title: t.title, owner: t.owner_required, done: t.status === 'completed', cls: t.owner_required ? 'owner' : t.status === 'completed' ? 'done' : 'work' });
  });
  (state.view.projects || []).forEach((p) => (p.milestones || []).forEach((m) => {
    if (m.due_at === day) out.push({ kind: 'milestone', item: m, title: `◆ ${m.title}`, owner: m.owner_required, done: Boolean(m.done_at), cls: m.owner_required ? 'owner' : 'milestone' });
  }));
  return out;
}

function renderCalendar() {
  const [y, m] = state.month.split('-').map(Number);
  $('monthLabel').textContent = `${y} 年 ${m} 月`;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startDow = (first.getUTCDay() + 6) % 7; // 周一为首列
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(`${state.month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const today = todayIso();
  $('calendarGrid').innerHTML = cells.map((day) => {
    if (!day) return '<div class="cday out"></div>';
    const items = calendarItems(day);
    const ownerCount = items.filter((i) => i.owner && !i.done).length;
    return `<div class="cday ${day === today ? 'today' : ''}">
      <div class="num"><span>${Number(day.slice(8))}</span>${ownerCount ? `<span class="chip owner">亲手 ${ownerCount}</span>` : ''}</div>
      <div class="items">${items.slice(0, 4).map((i) => `<span class="citem ${i.cls} ${i.done ? 'done' : ''}" data-kind="${i.kind}" data-id="${esc(i.item.id)}" title="${esc(i.title)}">${esc(i.title)}</span>`).join('')}
      ${items.length > 4 ? `<span class="citem">+${items.length - 4}</span>` : ''}</div>
    </div>`;
  }).join('');
  $('calendarGrid').querySelectorAll('[data-kind]').forEach((node) => {
    node.addEventListener('click', () => {
      const { kind, id } = node.dataset;
      if (kind === 'task') openTask(id);
      else if (kind === 'schedule') openSchedule(id);
      else openMilestone(id);
    });
  });

  const doneDays = Object.keys(state.view.completedByDay || {})
    .filter((d) => d <= today)
    .sort().reverse().slice(0, 10);
  $('completedHistory').innerHTML = doneDays.length
    ? doneDays.map((d) => `<div class="done-day"><b>${d}</b><div class="done-items">${(state.view.completedByDay[d] || []).map((x) => `<span class="chip green">${esc(x.title)}</span>`).join('')}</div></div>`).join('')
    : '<div class="empty">还没有完成记录。</div>';
}

function openSchedule(id) {
  const item = (state.view.schedule || []).find((s) => s.id === id);
  if (!item) return;
  openSheet(item.title, `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">时间</div><div class="v">${esc((item.start_at || '').slice(0, 16).replace('T', ' '))}</div></div>
      <div class="meta-box"><div class="k">项目</div><div class="v">${esc(item.projectName || '—')}</div></div>
      <div class="meta-box"><div class="k">类型</div><div class="v">${esc(item.kind)}</div></div>
      <div class="meta-box"><div class="k">需要你亲手</div><div class="v">${item.owner_required ? '是' : '否'}</div></div>
    </div>
    <div class="block"><h4>说明</h4><p>${esc(item.detail || '没有说明。')}</p></div>
    <button class="primary" id="doneToggle">${item.done ? '标记为未完成' : '标记为完成'}</button>`);
  $('doneToggle').addEventListener('click', async () => {
    try {
      await api(`/api/studio/schedule?id=${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ done: !item.done }) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function openMilestone(id) {
  const m = (state.view.projects || []).flatMap((p) => p.milestones || []).find((x) => x.id === id);
  if (!m) return;
  const project = (state.view.projects || []).find((p) => p.id === m.project_id);
  openSheet(m.title, `<div class="meta-grid">
      <div class="meta-box"><div class="k">项目</div><div class="v">${esc(project?.name || '—')}</div></div>
      <div class="meta-box"><div class="k">日期</div><div class="v">${esc(m.due_at)}</div></div>
      <div class="meta-box"><div class="k">状态</div><div class="v">${m.done_at ? '已完成 ' + esc(m.done_at) : '未完成'}</div></div>
      <div class="meta-box"><div class="k">你亲手</div><div class="v">${m.owner_required ? '是' : '否'}</div></div>
    </div>
    <div class="block"><h4>备注</h4><p>${esc(m.note || '无')}</p></div>
    <button class="primary" id="msToggle">${m.done_at ? '撤销完成' : '标记完成'}</button>`);
  $('msToggle').addEventListener('click', async () => {
    try {
      await api(`/api/studio/milestones?id=${encodeURIComponent(m.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ done_at: m.done_at ? '' : todayIso() }),
      });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function renderTimeline() {
  const from = new Date(`${todayIso()}T00:00:00Z`).getTime() - 30 * 864e5;
  const to = new Date(`${todayIso()}T00:00:00Z`).getTime() + 45 * 864e5;
  const W = Math.max(1100, $('timelineCanvas').clientWidth || 1200), L = 150, R = 30, rowH = 42, top = 34;
  const projects = (state.view.projects || []).filter((p) => !['killed', 'cancelled'].includes(p.status));
  const H = top + Math.max(1, projects.length) * rowH + 20;
  const x = (day) => L + ((new Date(`${day}T00:00:00Z`).getTime() - from) / (to - from)) * (W - L - R);
  const todayX = x(todayIso());
  const ticks = [];
  for (let i = 0; i <= 5; i += 1) {
    const t = new Date(from + ((to - from) * i) / 5).toISOString().slice(0, 10);
    const px = L + ((W - L - R) * i) / 5;
    ticks.push(`<line x1="${px}" y1="${top - 10}" x2="${px}" y2="${H - 10}" stroke="#eef4f0"/><text x="${px}" y="${top - 16}" text-anchor="middle">${dayLabel(t)}</text>`);
  }
  const rows = projects.map((p, idx) => {
    const y = top + idx * rowH + 10;
    const events = (state.view.events || []).filter((e) => e.projectId === p.id && e.date >= new Date(from).toISOString().slice(0, 10) && e.date <= new Date(to).toISOString().slice(0, 10));
    const nodes = events.map((e) => {
      const ex = x(e.date);
      const owner = e.owner ? 'owner' : '';
      const tone = e.status === 'completed' ? '#2f9b63' : e.status === 'blocked' ? '#a43f39' : e.status === 'at_risk' ? '#a9761b' : e.type === 'milestone' ? '#244e80' : '#4fb37c';
      const shape = e.type === 'milestone'
        ? `<rect x="${ex - 4}" y="${y - 4}" width="8" height="8" fill="${tone}" transform="rotate(45 ${ex} ${y})"/>`
        : `<circle cx="${ex}" cy="${y}" r="4.6" fill="${tone}"/>`;
      return `<g><title>${esc(`${e.date} · ${e.projectName || ''}\n${e.title}\n${TASK_STATUS[e.status] || e.status}${e.ownerRequired ? ' · 你要亲手做' : ''}`)}</title>
        ${owner ? `<circle cx="${ex}" cy="${y}" r="9" fill="none" stroke="#0e2444" stroke-width="1.4"/>` : ''}${shape}</g>`;
    }).join('');
    return `<text x="8" y="${y + 4}" fill="#193a64">${esc(p.name).slice(0, 20)}</text>
      <line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="#dfeae3" stroke-width="1"/>${nodes}`;
  }).join('');
  $('timelineCanvas').innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="项目时间线">
    ${ticks.join('')}
    <line x1="${todayX}" y1="${top - 10}" x2="${todayX}" y2="${H - 10}" stroke="#a9761b" stroke-dasharray="3 3"/>
    <text x="${todayX}" y="${H - 12}" text-anchor="middle" fill="#a9761b">今天</text>
    ${rows}
  </svg>`;
  $('timelineLegend').innerHTML = [
    ['#4fb37c', '任务节点'], ['#244e80', '里程碑'], ['#a43f39', '受阻'], ['#a9761b', '有风险'],
  ].map(([color, label]) => `<span><i style="background:${color}"></i>${label}</span>`).join('') + '<span><i style="background:#0e2444"></i>深蓝环 = 需要你亲手</span>';
}

// ── 第四层：Agent Log ──────────────────────────────────────
function renderLog() {
  const v = state.view;
  const today = v.day;
  const todayTokens = (v.audit || []).reduce((s, a) => s + a.tokens, 0);
  const todayWaste = (v.audit || []).reduce((s, a) => s + a.waste, 0);
  const advances = (v.audit || []).reduce((s, a) => s + a.advances, 0);
  const missing = (v.unaudited || []).length;
  const reports = (v.feed || []).length;
  $('logKpis').innerHTML = [
    ['今日 token', compact(todayTokens), `覆盖 ${(v.tokens?.byProject || []).length} 个项目`, ''],
    ['空耗 token', compact(todayWaste), todayTokens ? `占 ${Math.round((todayWaste / todayTokens) * 100)}%` : '无消耗', todayWaste ? 'warn' : 'good'],
    ['今日推进', fmt(advances), `${reports} 条汇报`, advances ? 'good' : ''],
    ['未交 log', fmt(missing), missing ? '有人花了 token 没交代' : '都交了', missing ? 'bad' : 'good'],
    ['在跑项目', fmt((v.projects || []).filter((p) => !['done', 'killed', 'cancelled', 'not_started'].includes(p.status)).length), `共 ${(v.projects || []).length} 个`, ''],
    ['卡住', fmt((v.stuck || []).length || (v.projects || []).filter((p) => p.is_stuck).length), '需要解锁', (v.projects || []).some((p) => p.is_stuck) ? 'warn' : 'good'],
  ].map(([label, value, sub, tone]) => `<div class="kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');

  const byAgent = (v.tokens?.byAgent || []).slice().sort((a, b) => b.tokens - a.tokens);
  const maxA = Math.max(1, ...byAgent.map((x) => x.tokens));
  $('chartAgent').innerHTML = byAgent.length
    ? byAgent.map((x) => barRow(x.name || x.agent, x.tokens, maxA)).join('')
    : '<div class="empty">近 30 天没有 token 记账。</div>';

  const byProject = (v.tokens?.byProject || []).slice().sort((a, b) => b.tokens - a.tokens);
  const maxP = Math.max(1, ...byProject.map((x) => x.tokens));
  $('chartProject').innerHTML = byProject.length
    ? byProject.map((x) => barRow(x.name, x.tokens, maxP)).join('')
    : '<div class="empty">还没有按项目记账。</div>';

  const byModel = (v.tokens?.byModel || []).slice().sort((a, b) => b.tokens - a.tokens);
  const maxM = Math.max(1, ...byModel.map((x) => x.tokens));
  $('chartModel').innerHTML = byModel.length
    ? byModel.map((x) => barRow(x.model, x.tokens, maxM)).join('')
    : '<div class="empty">没有来源数据。</div>';

  const hist = v.history || [];
  const peak = Math.max(1, ...hist.map((h) => h.tokens));
  const w = 620, h = 132;
  const step = w / Math.max(1, hist.length);
  const bars = hist.map((row, i) => {
    const bh = Math.max(1, (row.tokens / peak) * (h - 20));
    const wh = Math.max(0, (row.waste / peak) * (h - 20));
    const x = i * step + 1.5;
    const bw = Math.max(2, step - 3);
    return `<rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="2" fill="#b7dfc7"/>
      <rect x="${x}" y="${h - wh}" width="${bw}" height="${wh}" rx="2" fill="#a9761b" opacity=".75"/>`;
  }).join('');
  $('chartTrend').innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="30 天 token">
      ${bars}</svg>
    <div class="legend"><span><i style="background:#b7dfc7"></i>token</span><span><i style="background:#a9761b"></i>空耗</span>
      <span>${esc(hist[0]?.day || '')} → ${esc(hist[hist.length - 1]?.day || '')}</span></div>`;

  const audit = v.audit || [];
  $('auditTable').innerHTML = audit.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Bot</th><th class="num">token</th><th class="num">空耗</th><th class="num">空耗率</th><th class="num">汇报</th><th class="num">推进</th><th class="num">耗在停滞</th><th>标记</th></tr></thead>
    <tbody>${audit.map((a) => `<tr class="${a.flags.filter((f) => f !== 'declared_waste').length ? 'flagged' : ''}">
      <td><b>${esc(a.name || a.agent)}</b></td>
      <td class="num">${compact(a.tokens)}</td>
      <td class="num">${compact(a.waste)}</td>
      <td class="num">${Math.round((a.wasteRate || 0) * 100)}%</td>
      <td class="num">${fmt(a.reports)}</td>
      <td class="num">${fmt(a.advances)}</td>
      <td class="num">${compact(a.stalledTokens)}</td>
      <td>${a.flags.map((f) => `<span class="tag ${f === 'no_log' || f === 'spend_on_stalled' ? 'bad' : 'warn'}">${esc(FLAG[f] || f)}</span>`).join('') || '—'}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">今天还没有 token 记账。等 bot 调用 /api/studio/tokens。</div>';

  $('projectProgress').innerHTML = (v.projects || []).length
    ? (v.projects || []).map((p) => `<div class="pl-row">
        <div class="pl-top"><b>${esc(p.name)}</b><span>${p.progressPct}% · ${esc(STAGE_LABEL[p.stage] || p.stage)}${p.is_stuck ? ' · 卡住' : ''}</span></div>
        <div class="pbar"><i style="width:${p.progressPct}%"></i></div></div>`).join('')
    : '<div class="empty">没有项目。</div>';

  const logs = v.logs || [];
  $('logCards').innerHTML = logs.length
    ? logs.map((l) => `<article class="log-card"><header><b>${esc(agentName(l.agent))}</b><span>${esc(l.day)} · ${compact(l.tokens_total)} token · 空耗 ${compact(l.waste_tokens)}</span></header>
        <pre>${esc(l.log_markdown)}</pre></header></article>`).join('')
    : '<div class="empty">今天还没有 Agent log。</div>';
}

// ── 第五层：值班室（bot 登记 + 传信员待命 + 派单队列）─────────
const DISPATCH_STATUS = {
  pending: ['待领取', 'warn'], claimed: ['已领取', ''], delivered: ['已送达', 'good'],
  acked: ['已完成', 'good'], expired: ['已过期', ''], cancelled: ['已取消', ''],
};
const KIND_LABEL = { bot: 'bot', relay: '传信员', human: '人' };

function ago(seconds) {
  if (seconds === null || seconds === undefined) return '从未';
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function renderRelay() {
  const relay = state.view?.relay || { agents: [], dispatches: [], counts: {} };
  const c = relay.counts || {};
  const agents = (relay.agents || []).slice().sort((a, b) =>
    (b.active === false ? 0 : 1) - (a.active === false ? 0 : 1) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.id.localeCompare(b.id));
  const onlineBots = agents.filter((a) => a.kind === 'bot' && a.online).length;
  const onlineRelays = agents.filter((a) => a.kind === 'relay' && a.online).length;

  $('relayKpis').innerHTML = [
    ['待领取', fmt(c.pending || 0), '等传信员来取', (c.pending || 0) ? 'warn' : 'good'],
    ['已领取', fmt(c.claimed || 0), '已叫醒、未回执', ''],
    ['已送达', fmt(c.delivered || 0), '等 bot 自己做完', ''],
    ['在线 bot', fmt(onlineBots), `共 ${c.bots || 0} 个登记`, ''],
    ['在线传信员', fmt(onlineRelays), `共 ${c.relays || 0} 个登记`, onlineRelays ? 'good' : ''],
    ['登记总数', fmt(c.total || agents.length), `${(c.humans || 0)} 个人`, ''],
  ].map(([label, value, sub, tone]) => `<div class="kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');

  $('agentTable').innerHTML = agents.length ? `<div class="table-wrap"><table>
    <thead><tr><th>名字</th><th>类型</th><th>平台</th><th>能力</th><th>代它待命</th><th>状态</th><th class="num">未完成单</th><th>令牌</th><th></th></tr></thead>
    <tbody>${agents.map((a) => `<tr>
      <td><b>${esc(a.display_name || a.id)}</b><div class="sub mono">${esc(a.id)}</div></td>
      <td><span class="tag ${a.kind === 'relay' ? 'warn' : 'good'}">${esc(KIND_LABEL[a.kind] || a.kind)}</span></td>
      <td>${esc(a.platform || '—')}</td>
      <td>${(a.capabilities || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('') || '—'}</td>
      <td>${a.relay_agent ? esc(agentName(a.relay_agent)) : '—'}</td>
      <td>${a.active === false
        ? '<span class="tag bad">已下线</span>'
        : a.online
          ? `<span class="tag good">在线</span><div class="sub">${ago(a.seconds_since_seen)}</div>`
          : `<span class="tag warn">离线</span><div class="sub">${ago(a.seconds_since_seen)}</div>`}</td>
      <td class="num">${fmt(a.open_dispatches || 0)}</td>
      <td>${a.hasToken ? '<span class="tag good">有</span>' : '<span class="tag">无</span>'}</td>
      <td class="row-btns">
        <button class="ghost small" data-rotate="${esc(a.id)}">换令牌</button>
        <button class="ghost small" data-retire="${esc(a.id)}">下线</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">还没有登记任何 bot。用右上「+ bot」或让 bot 自己 POST /api/studio/agents。</div>';

  const dispatches = relay.dispatches || [];
  $('dispatchTable').innerHTML = dispatches.length ? `<div class="table-wrap"><table>
    <thead><tr><th>队列标题（只这一行字）</th><th>交给</th><th>传信员</th><th>状态</th><th>优先</th><th>入队</th><th></th></tr></thead>
    <tbody>${dispatches.map((d) => {
      const [label, tone] = DISPATCH_STATUS[d.status] || [d.status, ''];
      return `<tr>
        <td><b>${esc(d.headline)}</b><div class="sub">${esc(d.projectName || '')}${d.task_id ? ` · 任务 <span class="mono">${esc(String(d.task_id).slice(0, 8))}</span>` : ''}</div></td>
        <td>${esc(d.targetName || d.target_agent)}</td>
        <td>${esc(d.relayName || d.relay_agent || '未指定')}</td>
        <td><span class="tag ${tone}">${esc(label)}</span>${d.attempts > 1 ? `<div class="sub">取过 ${d.attempts} 次</div>` : ''}</td>
        <td>${esc(PRIORITY[d.priority] || d.priority)}</td>
        <td>${shortDate((d.created_at || '').slice(0, 10))}</td>
        <td class="row-btns">
          ${d.status === 'claimed' ? `<button class="ghost small" data-mark="delivered" data-id="${esc(d.id)}">已送达</button>` : ''}
          ${d.status === 'delivered' ? `<button class="ghost small" data-mark="acked" data-id="${esc(d.id)}">已完成</button>` : ''}
          <button class="ghost small" data-cancel="${esc(d.id)}">取消</button>
        </td>
      </tr>`;
    }).join('')}</tbody></table></div>`
    : '<div class="empty">队列空着。任务派给谁，这里就会出现一行「有任务」。</div>';

  const lines = [
    '# 传信员待命：挂着直到有单（wait 最多 45 秒），或到期返回空',
    '# cover=1：也代领「没指定传信员」的单；只管自己名下的就去掉',
    'curl -s "$BASE/api/studio/inbox?relay=<传信员 id>&wait=25&take=1&cover=1" -H "Authorization: Bearer $TOKEN"',
    '',
    '# 叫醒 bot 后回执（不搬运正文）',
    'curl -s -X PATCH "$BASE/api/studio/dispatch?id=<单 id>" -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" -d \'{"status":"delivered"}\'',
    '',
    '# bot 自己去取正文',
    'curl -s "$BASE/api/studio/prompt?task=<任务 id>" -H "Authorization: Bearer $BOT_TOKEN"',
    '',
    '# 报到 / 心跳（在线状态靠这个）',
    'curl -s -X PATCH "$BASE/api/studio/agents?id=<bot id>" -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" -d \'{"heartbeat":true}\'',
  ];
  const pre = document.createElement('pre');
  pre.className = 'snippet';
  pre.textContent = lines.join('\n');
  const host = `http://${location.host}`;
  const note = document.createElement('p');
  note.className = 'sub';
  note.style.marginBottom = '10px';
  note.textContent = `BASE = ${host}；TOKEN 是这个 bot 登记时拿到的那串。完整契约见 /api-docs。`;
  $('relaySnippet').replaceChildren(note, pre);
}

// ── 公告栏 ─────────────────────────────────────────────────
const ANN_KIND = { update: ['更新', 'good'], fix: ['修复', 'good'], notice: ['通知', ''], incident: ['故障', 'bad'] };
const ANN_SEVERITY = { info: '一般', important: '重要', critical: '严重' };
const ANN_AUDIENCE = { all: '所有人', relay: '传信员', bot: 'bot', owner: '主人' };

function relTime(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '—';
  return ago(Math.round((Date.now() - t) / 1000));
}

function renderBoard() {
  const list = state.view?.announcements || [];
  const week = list.filter((a) => Date.now() - new Date(a.published_at).getTime() < 7 * 864e5).length;
  $('boardMeta').textContent = `${list.length} 条在架 · 最近 7 天 ${week} 条 · 传信员每轮 probe 一次就能看到新的`;

  $('announcementList').innerHTML = list.length ? list.map((a) => {
    const [kindLabel, kindTone] = ANN_KIND[a.kind] || [a.kind, ''];
    const alert = a.severity === 'critical' ? 'incident' : a.severity === 'important' ? 'important' : a.kind;
    return `<div class="ann-item ${esc(alert)} ${a.archived ? 'archived' : ''}">
      <header>
        <h4>${esc(a.title)}</h4>
        <span class="row-btns"><button class="ghost small" data-archive="${esc(a.id)}">下架</button></span>
      </header>
      <div class="ann-meta">
        <span class="tag ${kindTone}">${esc(kindLabel)}</span>
        <span class="chip">${esc(ANN_SEVERITY[a.severity] || a.severity)}</span>
        <span class="chip">给 ${esc(ANN_AUDIENCE[a.audience] || a.audience)}</span>
        ${a.version ? `<span class="chip navy mono">${esc(a.version)}</span>` : ''}
        <span class="mono">${esc(a.created_by)}</span>
        <span title="${esc(a.published_at)}">${relTime(a.published_at)}</span>
      </div>
      ${a.body ? `<div class="ann-body">${esc(a.body)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty">还没有公告。点右上「+ 公告」写第一条，传信员下一轮值班就会看到。</div>';

  const lines = [
    '# 传信员每轮值班顺手探一次：只回「有没有新的」，不搬正文',
    'curl -s "$BASE/api/studio/announcements?probe=1&since=$CURSOR&audience=relay" -H "Authorization: Bearer $TOKEN"',
    '',
    '# changed=true 再取正文，然后把返回的 cursor 存回自己的配置',
    'curl -s "$BASE/api/studio/announcements?since=$CURSOR&audience=relay&limit=20" -H "Authorization: Bearer $TOKEN"',
    '',
    '# 第一次还没有 cursor：不带 since，返回的 cursor 就是起点',
    'curl -s "$BASE/api/studio/announcements?probe=1&audience=relay" -H "Authorization: Bearer $TOKEN"',
    '',
    '# bot 修完东西自己发一条（作者本人或 owner 才能改/下架）',
    'curl -s -X POST "$BASE/api/studio/announcements" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
    '  --data-binary @ann.json   # {"title":"修好了 X","body":"改了 A → B，传信员不用动","kind":"fix","severity":"important","audience":"relay"}',
  ];
  const pre = document.createElement('pre');
  pre.className = 'snippet';
  pre.textContent = lines.join('\n');
  const note = document.createElement('p');
  note.className = 'sub';
  note.style.marginBottom = '10px';
  note.textContent = 'BASE = 平台地址，TOKEN = 传信员自己的 wbt_ 令牌。changed 判断即可，不必每轮拉正文。';
  $('boardSnippet').replaceChildren(note, pre);
}

// ── 渲染总入口 ─────────────────────────────────────────────
function renderAll() {
  renderPrails();
  if (state.tab === 'products') { renderProducts(); renderBuckets(); }
  if (state.tab === 'kanban') renderKanban();
  if (state.tab === 'calendar') {
    if (state.calMode === 'calendar') renderCalendar(); else renderTimeline();
  }
  if (state.tab === 'log') renderLog();
  if (state.tab === 'relay') renderRelay();
  if (state.tab === 'board') renderBoard();
}

const TAB_META = {
  products: ['第一层', '产品与进度', '+ 产品', () => newProductForm()],
  kanban: ['第二层', 'Kanban', '+ 任务', () => newTaskForm()],
  calendar: ['第三层', '日历 / 时间线', '+ 日程', () => newScheduleForm()],
  log: ['第四层', 'Agent Log', '刷新', () => load()],
  relay: ['值班室', 'bot 登记 · 传信员待命', '+ 派单', () => newDispatchForm()],
  board: ['公告栏', '平台更新 · 修复 · 通知', '+ 公告', () => newAnnouncementForm()],
};

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  ['products', 'kanban', 'calendar', 'log', 'relay', 'board'].forEach((key) => $(`layer-${key}`).classList.toggle('hidden', key !== tab));
  const [eyebrow, title, action, fn] = TAB_META[tab];
  $('layerEyebrow').textContent = eyebrow;
  $('layerTitle').textContent = title;
  const btn = $('primaryAction');
  if (tab === 'log') { btn.classList.add('hidden'); } else { btn.classList.remove('hidden'); btn.textContent = action; }
  btn.onclick = fn;
  renderAll();
}

// ── 新建表单 ───────────────────────────────────────────────
function agentOptions(selected) {
  return (state.view?.agents || []).map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.display_name)}</option>`).join('');
}

function newProductForm() {
  openSheet('新建产品', `<form class="stack" id="newProduct">
    <label>名称<input name="name" maxlength="180" required placeholder="例如：Prasad Shelf" /></label>
    <div class="row2">
      <label>负责 bot<select name="owner_agent">${agentOptions('dev2')}</select></label>
      <label>变现方式<input name="monetization_model" maxlength="240" placeholder="例如：每单抽成" /></label>
    </div>
    <label>目标用户<input name="target_user" maxlength="240" /></label>
    <label>综述<textarea name="summary" maxlength="8000"></textarea></label>
    <label>规划<textarea name="plan" maxlength="8000"></textarea></label>
    <button class="primary" type="submit">创建产品</button>
    <p class="hint">产品是项目之上的一层：一个产品可以带多个项目。</p>
  </form>`);
  $('newProduct').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/studio/products', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function newProjectForm() {
  const products = state.view.products || [];
  openSheet('新建项目', `<form class="stack" id="newProject">
    <label>项目名<input name="name" maxlength="180" required /></label>
    <div class="row2">
      <label>所属产品<select name="product_id"><option value="">不挂产品</option>${products.map((p) => `<option value="${esc(p.id)}" ${p.id === state.product ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>分类<input name="category" maxlength="80" placeholder="例如：工具 / 电商" /></label>
    </div>
    <div class="row3">
      <label>阶段<select name="stage">${STAGES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>状态<select name="status">${BUCKETS.map(([k, label]) => `<option value="${k === 'active' ? 'active' : k === 'killed' ? 'killed' : k}">${label}</option>`).join('')}</select></label>
      <label>负责 bot<select name="owner_agent">${agentOptions('dev2')}</select></label>
    </div>
    <label>项目简介<textarea name="summary" maxlength="6000"></textarea></label>
    <label>项目目的<textarea name="purpose" maxlength="4000"></textarea></label>
    <label>项目规划<textarea name="plan" maxlength="8000"></textarea></label>
    <div class="row2">
      <label>仓库<input name="repo_url" maxlength="500" placeholder="https://github.com/..." /></label>
      <label>预览<input name="preview_url" maxlength="500" placeholder="https://...vercel.app" /></label>
    </div>
    <button class="primary" type="submit">创建项目</button>
  </form>`);
  $('newProject').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/studio/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function newTaskForm() {
  const projects = state.view.projects || [];
  openSheet('新建任务', `<form class="stack" id="newTask">
    <label>任务标题<input name="title" maxlength="200" required /></label>
    <div class="row2">
      <label>项目<select name="project_id">${projects.map((p) => `<option value="${esc(p.id)}" ${state.product && p.product_id === state.product ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>接手 bot<select name="assignee_agent">${agentOptions('dev2')}</select></label>
    </div>
    <div class="row3">
      <label>状态<select name="status">${TASK_ORDER.map((k) => `<option value="${k}">${TASK_STATUS[k]}</option>`).join('')}</select></label>
      <label>优先级<select name="priority"><option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></label>
      <label>截止<input name="due_at" type="date" /></label>
    </div>
    <label>任务规划<textarea name="plan" maxlength="8000"></textarea></label>
    <label class="checkline"><input type="checkbox" name="owner_required" /> 需要主人亲手执行 / 把关</label>
    <button class="primary" type="submit">创建任务</button>
  </form>`);
  $('newTask').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.owner_required = form.get('owner_required') === 'on';
    try {
      await api('/api/studio/tasks', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function newScheduleForm() {
  const projects = state.view.projects || [];
  openSheet('新建日程', `<form class="stack" id="newSchedule">
    <label>标题<input name="title" maxlength="200" required /></label>
    <div class="row2">
      <label>日期<input name="day" type="date" value="${state.view.day}" required /></label>
      <label>类型<select name="kind"><option value="work">工作</option><option value="review">检查</option><option value="decision">决策</option><option value="owner">我要做</option><option value="milestone">里程碑</option><option value="payment">付款</option></select></label>
    </div>
    <label>项目<select name="project_id"><option value="">不挂项目</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
    <label>说明<textarea name="detail" maxlength="4000"></textarea></label>
    <label class="checkline"><input type="checkbox" name="owner_required" /> 必须主人亲手执行 / 把关</label>
    <button class="primary" type="submit">创建日程</button>
  </form>`);
  $('newSchedule').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.owner_required = form.get('owner_required') === 'on';
    try {
      await api('/api/studio/schedule', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

// ── 公告栏表单 ─────────────────────────────────────────────
function newAnnouncementForm() {
  openSheet('发公告', `<form class="stack" id="newAnnouncementForm">
    <label>标题<input name="title" maxlength="200" required placeholder="例如：公告栏上线 / 修好了换令牌后旧令牌不失效" /></label>
    <div class="row3">
      <label>类型<select name="kind"><option value="update">更新</option><option value="fix">修复</option><option value="notice">通知</option><option value="incident">故障</option></select></label>
      <label>重要度<select name="severity"><option value="info">一般</option><option value="important">重要</option><option value="critical">严重</option></select></label>
      <label>给谁看<select name="audience"><option value="all">所有人</option><option value="relay">传信员</option><option value="bot">bot</option><option value="owner">主人</option></select></label>
    </div>
    <label>版本号 / 标记<input name="version" maxlength="40" placeholder="可空，例如 2026.11.14" /></label>
    <label>正文<textarea name="body" maxlength="8000" rows="7" placeholder="改了什么、哪条接口变了、传信员要不要动脚本"></textarea></label>
    <button class="primary" type="submit">发布</button>
    <p class="hint">发布后传信员下一轮 probe 就能看到。写清「谁需要做什么」，比只写「已修复」有用。</p>
  </form>`);
  $('newAnnouncementForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/studio/announcements', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

async function archiveAnnouncement(id) {
  await api(`/api/studio/announcements?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  await load();
}

// ── 值班室表单 ─────────────────────────────────────────────
function showTokenPanel(res) {
  const token = res?.token;
  const name = res?.agent?.display_name || res?.agent?.id || '';
  if (!token) {
    $('modalError').textContent = res?.tokenNote || '这次没有返回令牌。';
    return;
  }
  openSheet('令牌（只显示这一次）', `<div class="stack">
    <p class="sub">${esc(name)} 的令牌：</p>
    <textarea id="tokenBox" class="mono" readonly rows="3">${esc(token)}</textarea>
    <div class="row-actions">
      <button id="copyToken" class="primary" type="button">复制</button>
      <button id="tokenDone" class="ghost" type="button">我已存好</button>
    </div>
    <p class="hint">库里只存哈希，关掉这个窗口就再也看不到。要换新的：登记表里点「换令牌」。</p>
  </div>`);
  $('copyToken').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      $('copyToken').textContent = '已复制';
    } catch {
      $('tokenBox').select();
      $('modalError').textContent = '浏览器不让自动复制，已选中，按 Ctrl+C。';
    }
  });
  $('tokenDone').addEventListener('click', closeSheet);
}

function registerAgentForm(kind) {
  const isRelay = kind === 'relay';
  const relays = (state.view?.relay?.agents || []).filter((a) => a.kind === 'relay' && a.active !== false);
  openSheet(isRelay ? '登记传信员' : '登记 bot', `<form class="stack" id="registerAgent">
    <div class="row2">
      <label>id（唯一，小写字母数字）<input name="id" required pattern="[a-z0-9_\\-]{2,32}" placeholder="${isRelay ? 'relay-openbot' : 'prasad-crawler'}" /></label>
      <label>显示名<input name="display_name" maxlength="80" /></label>
    </div>
    <div class="row2">
      <label>平台<input name="platform" maxlength="40" placeholder="OpenBot / Hermes / Codex CLI" /></label>
      <label>角色<input name="role" maxlength="80" placeholder="执行 / 汇报 / 待命" /></label>
    </div>
    <label>能力（逗号分隔）<input name="capabilities" maxlength="300" placeholder="code, crawl, research" /></label>
    <div class="row2">
      <label>联系方式<input name="contact" maxlength="200" placeholder="在平台上怎么找到它：@handle / 群名 / URL" /></label>
      <label>心跳间隔（秒）<input name="heartbeat_s" type="number" min="15" max="3600" value="60" /></label>
    </div>
    ${isRelay ? '' : `<label>由谁代它待命<select name="relay_agent"><option value="">不指定（平台直连）</option>${relays.map((r) => `<option value="${esc(r.id)}">${esc(r.display_name || r.id)}</option>`).join('')}</select></label>`}
    <label>备注<textarea name="notes" maxlength="1000"></textarea></label>
    <button class="primary" type="submit">登记并取令牌</button>
    <p class="hint">${isRelay ? '传信员自己也要有令牌，才能挂着 inbox 等单。' : '登记后返回的令牌要存进这个 bot 的配置。'}</p>
  </form>`);
  $('registerAgent').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.kind = kind;
    body.heartbeat_s = Number(body.heartbeat_s) || 60;
    if (isRelay) delete body.relay_agent;
    try {
      const res = await api('/api/studio/agents', { method: 'POST', body: JSON.stringify(body) });
      showTokenPanel(res);
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

function newDispatchForm() {
  const tasks = (state.view?.tasks || []).filter((t) => t.status !== 'completed');
  const agents = (state.view?.relay?.agents || []).filter((a) => a.active !== false);
  const bots = agents.filter((a) => a.kind !== 'relay');
  const relays = agents.filter((a) => a.kind === 'relay');
  openSheet('手动派单', `<form class="stack" id="newDispatch">
    <label>任务<select name="task_id">${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.projectName ? `${t.projectName} · ` : '')}${esc(t.title)}</option>`).join('') || '<option value="">没有未完成的任务</option>'}</select></label>
    <div class="row2">
      <label>交给<select name="target_agent">${bots.map((b) => `<option value="${esc(b.id)}">${esc(b.display_name || b.id)}</option>`).join('') || '<option value="">先登记 bot</option>'}</select></label>
      <label>优先级<select name="priority"><option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></label>
    </div>
    <label>传信员<select name="relay_agent"><option value="">用 bot 绑定的那个</option>${relays.map((r) => `<option value="${esc(r.id)}">${esc(r.display_name || r.id)}</option>`).join('')}</select></label>
    <label>队列标题（留空自动生成）<input name="headline" maxlength="300" placeholder="【项目】任务标题" /></label>
    <label>提示（可选）<input name="hint" maxlength="500" placeholder="例如：先看 README 再动手" /></label>
    <button class="primary" type="submit">入队</button>
    <p class="hint">队列只带一行标题和任务 id；正文由 bot 接单后自己取。</p>
  </form>`);
  $('newDispatch').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    if (!body.task_id) { $('modalError').textContent = '没有可派的任务。'; return; }
    if (!body.target_agent) { $('modalError').textContent = '先登记一个 bot。'; return; }
    for (const key of ['headline', 'hint', 'relay_agent']) if (!body[key]) delete body[key];
    try {
      await api('/api/studio/dispatch', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      await load();
    } catch (error) { $('modalError').textContent = error.message; }
  });
}

async function rotateToken(id) {
  const res = await api(`/api/studio/agents?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ rotate_token: true }),
  });
  showTokenPanel(res);
  await load();
}

async function retireAgent(id) {
  await api(`/api/studio/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  await load();
}

async function markDispatch(id, status) {
  await api(`/api/studio/dispatch?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  await load();
}

async function cancelDispatch(id) {
  await api(`/api/studio/dispatch?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  await load();
}

// ── 事件绑定 ───────────────────────────────────────────────
document.querySelectorAll('.rail-btn[data-tab]').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
$('allProducts').addEventListener('click', () => { state.product = null; renderAll(); });
$('refresh').addEventListener('click', () => load().catch((e) => { $('bootError').textContent = e.message; $('bootError').classList.remove('hidden'); }));
$('dayInput').addEventListener('change', () => load().catch(() => {}));
$('registerRelay').addEventListener('click', () => registerAgentForm('relay'));
$('registerBot').addEventListener('click', () => registerAgentForm('bot'));
$('manualDispatch').addEventListener('click', () => newDispatchForm());
$('agentTable').addEventListener('click', (event) => {
  const rotate = event.target.closest('[data-rotate]');
  const retire = event.target.closest('[data-retire]');
  if (rotate) guard(() => rotateToken(rotate.dataset.rotate))();
  if (retire) guard(() => retireAgent(retire.dataset.retire))();
});
$('dispatchTable').addEventListener('click', (event) => {
  const mark = event.target.closest('[data-mark]');
  const cancel = event.target.closest('[data-cancel]');
  if (mark) guard(() => markDispatch(mark.dataset.id, mark.dataset.mark))();
  if (cancel) guard(() => cancelDispatch(cancel.dataset.cancel))();
});
$('announcementList').addEventListener('click', (event) => {
  const archive = event.target.closest('[data-archive]');
  if (archive) guard(() => archiveAnnouncement(archive.dataset.archive))();
});
$('modalClose').addEventListener('click', closeSheet);
$('overlay').addEventListener('click', (event) => { if (event.target === $('overlay')) closeSheet(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet(); });
document.querySelectorAll('#calMode button').forEach((btn) => btn.addEventListener('click', () => {
  state.calMode = btn.dataset.mode;
  document.querySelectorAll('#calMode button').forEach((b) => b.classList.toggle('is-active', b === btn));
  $('calendarView').classList.toggle('hidden', state.calMode !== 'calendar');
  $('timelineView').classList.toggle('hidden', state.calMode !== 'timeline');
  if (state.calMode === 'timeline') renderTimeline(); else renderCalendar();
}));
$('prevMonth').addEventListener('click', () => shiftMonth(-1));
$('nextMonth').addEventListener('click', () => shiftMonth(1));
$('todayMonth').addEventListener('click', () => { state.month = todayIso().slice(0, 7); renderCalendar(); });

function shiftMonth(delta) {
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.month = d.toISOString().slice(0, 7);
  renderCalendar();
}

$('signOut').addEventListener('click', async () => {
  try {
    await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${session?.access_token ?? ''}` },
    });
  } catch {}
  localStorage.removeItem('bridge-session');
  session = null;
  $('login').classList.remove('hidden');
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    session = await signIn($('email').value, $('password').value);
    localStorage.setItem('bridge-session', JSON.stringify(session));
    $('login').classList.add('hidden');
    $('signOut').classList.remove('hidden');
    await load();
  } catch (error) { $('loginError').textContent = error.message; }
});

(async () => {
  try {
    await loadConfig();
  } catch (error) {
    $('loginError').textContent = error.message;
    return;
  }
  if (session?.access_token) {
    $('login').classList.add('hidden');
    $('signOut').classList.remove('hidden');
    try {
      await load();
    } catch (error) {
      localStorage.removeItem('bridge-session');
      session = null;
      $('login').classList.remove('hidden');
      $('loginError').textContent = error.message;
    }
  }
  switchTab('products');
  setInterval(() => {
    if (session && $('overlay').classList.contains('hidden')) load().catch(() => {});
  }, 60000);
})();
