#!/usr/bin/env node
// Studio 上报 CLI —— 给 Grokbot / Codex / Dev 2 / Hermes / OpenBot 用。
// 只依赖 Node 18+ 的 fetch。令牌只从环境变量读，不要写进仓库。
//
//   set WB_BASE_URL=https://codechat-five.vercel.app
//   set WB_TOKEN=<该 bot 的 bridge token>
//
//   node scripts/wb.mjs report --project "Agent Bridge" --summary "..." --outcome advanced
//   node scripts/wb.mjs token --project "Agent Bridge" --in 120000 --out 9000 --waste 15000 --reason "重复读取同一文件"
//   node scripts/wb.mjs log --file my-log.md --projects "Agent Bridge" --done 3 --failed 0
//   node scripts/wb.mjs status

const args = process.argv.slice(2);
const command = args[0] || 'help';

function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const base = (process.env.WB_BASE_URL || '').replace(/\/$/, '');
const token = process.env.WB_TOKEN || '';

function fail(message) {
  console.error(`错误：${message}`);
  process.exitCode = 1;
}

async function post(path, body, label) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    console.error(`失败：${label} → HTTP ${response.status} ${JSON.stringify(data)}`);
    process.exitCode = 1;
    return null;
  }
  console.log(`已上报：${label} → ${JSON.stringify(data)}`);
  return data;
}

function need(value, name) {
  if (!value || value === true) {
    fail(`缺少 --${name}`);
    return null;
  }
  return value;
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log('用法：node scripts/wb.mjs <report|token|log|status> [选项]\n详见 docs/API.md');
    return;
  }
  if (!base || !token) return fail('先设置 WB_BASE_URL 和 WB_TOKEN。');

  if (command === 'report') {
    const summary = need(flag('summary'), 'summary');
    if (!summary) return;
    await post('/api/studio/report', {
      project: flag('project') === true ? undefined : flag('project'),
      project_id: flag('project-id') === true ? undefined : flag('project-id'),
      kind: flag('kind', 'progress'),
      summary,
      detail: flag('detail') === true ? undefined : flag('detail'),
      percent: flag('percent') === true ? undefined : flag('percent'),
      outcome: flag('outcome'),
      blocked: Boolean(flag('blocked', false)),
      blocker_owner: flag('blocker-owner') === true ? undefined : flag('blocker-owner'),
      tokens_total: flag('tokens') === true ? undefined : flag('tokens'),
      task_id: flag('task-id') === true ? undefined : flag('task-id'),
      day: flag('day') === true ? undefined : flag('day'),
    }, 'progress report');
    return;
  }

  if (command === 'token') {
    const tokensIn = flag('in', '0');
    const tokensOut = flag('out', '0');
    const waste = flag('waste', '0');
    if (Number(waste) > 0 && !flag('reason')) return fail('空耗必须写 --reason，否则不接受记账。');
    await post('/api/studio/tokens', {
      project: flag('project') === true ? undefined : flag('project'),
      project_id: flag('project-id') === true ? undefined : flag('project-id'),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      waste_tokens: waste,
      waste_reason: flag('reason') === true ? undefined : flag('reason'),
      model: flag('model') === true ? undefined : flag('model'),
      sessions: flag('sessions') === true ? undefined : flag('sessions'),
      note: flag('note') === true ? undefined : flag('note'),
      day: flag('day') === true ? undefined : flag('day'),
    }, 'token usage');
    return;
  }

  if (command === 'log') {
    const file = need(flag('file'), 'file');
    if (!file) return;
    const { readFile } = await import('node:fs/promises');
    const markdown = await readFile(file, 'utf8');
    const projects = String(flag('projects', '') || '').split(',').map((item) => item.trim()).filter(Boolean);
    await post('/api/studio/logs', {
      log_markdown: markdown,
      projects,
      tasks_done: flag('done') === true ? undefined : flag('done'),
      tasks_failed: flag('failed') === true ? undefined : flag('failed'),
      self_review: flag('review') === true ? undefined : flag('review'),
      day: flag('day') === true ? undefined : flag('day'),
    }, 'agent log');
    return;
  }

  if (command === 'status') {
    const response = await fetch(`${base}/api/studio/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return fail(`读取失败：HTTP ${response.status} ${JSON.stringify(data)}`);
    const items = Array.isArray(data) ? data : [];
    if (!items.length) {
      console.log('还没有项目。先在 /studio 里加一个。');
      return;
    }
    for (const project of items) {
      const stuck = project.is_stuck ? '卡住' : '在动';
      const reason = project.blocked_reason ? ` · 卡在：${project.blocked_reason}` : '';
      console.log(`- ${project.name} [${project.stage}] ${project.status}/${stuck} · 本阶段 ${project.days_in_stage} 天 · ${project.days_since_progress} 天未推进${reason}`);
    }
    return;
  }

  fail(`未知命令：${command}`);
}

main().catch((error) => fail(error.message));
