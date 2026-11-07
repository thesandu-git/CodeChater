const $ = (id) => document.getElementById(id);
let config;
let session = JSON.parse(localStorage.getItem('bridge-session') || 'null');
let selectedTask = null;

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

function bearerHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
}

function setSignedIn(signedIn) {
  $('loginPanel').classList.toggle('hidden', signedIn);
  $('appPanel').classList.toggle('hidden', !signedIn);
  $('signOut').classList.toggle('hidden', !signedIn);
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { ...bearerHeaders(), ...(init.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败。');
  return data;
}

function statusLabel(status) {
  return ({ pending: '等待中', working: '处理中', needs_input: '需要输入', done: '已完成', failed: '失败' })[status] || status;
}

function agentLabel(value) {
  return ({ owner: '你', grokbot: 'Grokbot', codex: 'Codex', dev2: 'Dev 2' })[value] || value;
}

function safeDate(value) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderTasks(tasks) {
  const list = $('taskList');
  list.replaceChildren();
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">还没有任务。创建一条任务开始协作。</div>';
    $('conversation').classList.add('hidden');
    return;
  }
  tasks.forEach((task) => {
    const button = document.createElement('button');
    button.className = `task-row${selectedTask === task.id ? ' selected' : ''}`;
    const title = document.createElement('strong'); title.textContent = task.title;
    const meta = document.createElement('span'); meta.className = 'task-meta';
    const agent = document.createElement('span'); agent.textContent = agentLabel(task.assigned_to);
    const status = document.createElement('span'); status.className = 'status'; status.textContent = statusLabel(task.status);
    meta.append(agent, status); button.append(title, meta);
    button.addEventListener('click', () => { selectedTask = task.id; renderTasks(tasks); loadMessages(task); });
    list.append(button);
  });
  if (selectedTask && tasks.some((task) => task.id === selectedTask)) loadMessages(tasks.find((task) => task.id === selectedTask));
}

async function loadTasks() {
  const tasks = await api('/api/tasks');
  renderTasks(tasks);
}

async function loadMessages(task) {
  $('conversation').classList.remove('hidden');
  $('conversationTitle').textContent = task.title;
  const messages = await api(`/api/messages?task_id=${encodeURIComponent(task.id)}`);
  const container = $('messages'); container.replaceChildren();
  messages.forEach((entry) => {
    const card = document.createElement('article'); card.className = `message ${entry.sender === 'owner' ? 'owner' : ''}`;
    const head = document.createElement('div'); head.className = 'message-head';
    const who = document.createElement('span'); who.textContent = agentLabel(entry.sender);
    const date = document.createElement('span'); date.textContent = safeDate(entry.created_at);
    const body = document.createElement('div'); body.textContent = entry.body;
    head.append(who, date); card.append(head, body); container.append(card);
  });
  container.scrollTop = container.scrollHeight;
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    const result = await auth('token?grant_type=password', { email: $('email').value, password: $('password').value });
    session = result; localStorage.setItem('bridge-session', JSON.stringify(session));
    setSignedIn(true); await loadTasks();
  } catch (error) { $('loginError').textContent = error.message; }
});

$('signOut').addEventListener('click', async () => {
  try { await fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` } }); } catch {}
  localStorage.removeItem('bridge-session'); session = null; selectedTask = null; setSignedIn(false);
});

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('taskError').textContent = '';
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: $('taskTitle').value, body: $('taskBody').value, assigned_to: $('assignee').value }) });
    $('taskForm').reset(); selectedTask = null; await loadTasks();
  } catch (error) { $('taskError').textContent = error.message; }
});

$('refresh').addEventListener('click', () => loadTasks().catch((error) => { $('taskError').textContent = error.message; }));

(async () => {
  try { await loadConfig(); }
  catch (error) { $('loginError').textContent = error.message; return; }
  if (session?.access_token) {
    setSignedIn(true);
    try { await loadTasks(); } catch { localStorage.removeItem('bridge-session'); session = null; setSignedIn(false); }
    setInterval(() => { if (session) loadTasks().catch(() => {}); }, 7000);
  }
})();
