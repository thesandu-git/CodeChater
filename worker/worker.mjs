import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const baseUrl = required('BRIDGE_BASE_URL').replace(/\/$/, '');
const token = required('CODEX_BRIDGE_TOKEN');
const projectDir = required('CODEX_PROJECT_DIR');
const worktreeRoot = required('CODEX_WORKTREE_ROOT');
const codexCommand = process.env.CODEX_COMMAND || 'codex';
const pollMs = positiveInt(process.env.POLL_INTERVAL_MS, 8000);
const timeoutMs = positiveInt(process.env.TASK_TIMEOUT_MS, 20 * 60 * 1000);
const execFileAsync = promisify(execFile);
let stopping = false;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy worker/.env.example to worker/.env and configure it.`);
  return value;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redact(text) {
  let cleaned = text
    .replace(/gsk_[A-Za-z0-9_-]{16,}/g, '[REDACTED_GROQ_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]');
  for (const privatePath of [projectDir, worktreeRoot, process.env.USERPROFILE].filter(Boolean)) {
    cleaned = cleaned.replaceAll(privatePath, '[LOCAL_PATH]');
  }
  return cleaned;
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || `Bridge returned HTTP ${response.status}.`);
  return data;
}

async function postMessage(taskId, body, status) {
  return request('/api/agent/messages', {
    method: 'POST',
    body: JSON.stringify({ task_id: taskId, body: redact(body).slice(0, 12000), status }),
  });
}

async function createWorktree(task) {
  const root = path.resolve(worktreeRoot);
  const checkout = path.resolve(projectDir);
  if (root === checkout || root.startsWith(checkout + path.sep)) {
    throw new Error('CODEX_WORKTREE_ROOT must be outside CODEX_PROJECT_DIR.');
  }
  const target = path.resolve(root, task.id);
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid task worktree path.');
  if (existsSync(target)) throw new Error('Worktree path already exists; it was left untouched.');
  mkdirSync(root, { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '--detach', target, 'HEAD'], { cwd: checkout, windowsHide: true });
  return target;
}

function runCodex(task, taskDir) {
  const prompt = [
    'You are working in a separate Git worktree supplied as your working directory.',
    'Follow the user request below and make only the smallest relevant changes.',
    'Do not push, publish, deploy, merge, or alter files outside this checkout.',
    'Preserve unrelated and pre-existing changes. Do not add or run tests unless the user explicitly asks.',
    'Do not print, copy, or transmit secret values. If the request needs secrets, refer to environment-variable names only.',
    'At the end, summarize the changes, files touched, and any unresolved blockers. Do not include full source files in the summary.',
    '',
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    'Task details:',
    task.body,
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(codexCommand, [
      'exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--cd', taskDir, '-',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Codex exceeded the ${Math.round(timeoutMs / 60000)} minute task limit.`));
    }, timeoutMs);

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: redact(stdout), stderr: redact(stderr) });
    }

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-24000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(null, code));
    child.stdin.end(prompt);
  });
}

function summarizeRun(run) {
  const lines = run.stdout.split(/\r?\n/).filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        messages.push(event.item.text);
      }
      if (event.type === 'turn.completed' && typeof event.message === 'string') messages.push(event.message);
    } catch {}
  }
  const result = messages.at(-1) || run.stderr || run.stdout || `Codex exited with code ${run.code}.`;
  return redact(result).slice(0, 11000);
}

async function processTask(task) {
  await postMessage(task.id, '本机 Codex worker 已接收任务，正在独立 Git worktree 中处理。', 'working');
  try {
    const taskDir = await createWorktree(task);
    await postMessage(task.id, '已创建隔离工作目录，正在处理。', 'working');
    const run = await runCodex(task, taskDir);
    if (run.code === 0) await postMessage(task.id, summarizeRun(run), 'done');
    else await postMessage(task.id, `Codex 退出码 ${run.code}。\n${summarizeRun(run)}`, 'failed');
  } catch (error) {
    await postMessage(task.id, `本机 worker 未能完成任务：${redact(error.message)}`, 'failed');
  }
}

async function poll() {
  while (!stopping) {
    try {
      const tasks = await request('/api/agent/tasks?agent=codex');
      if (Array.isArray(tasks) && tasks.length) {
        for (const task of tasks) {
          if (stopping) break;
          await processTask(task);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
console.log(`Codex worker polling ${baseUrl}; project directory: ${projectDir}`);
await poll();
