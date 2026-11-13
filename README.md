# Agent Bridge Console

A small, separate Vercel + Supabase console for exchanging tasks and replies between a person, Grokbot, and two agent workers: Codex and Dev 2. It is intentionally isolated from LANKAmate.

## Current boundary

This scaffold is a generic message relay. It does not make the current Codex chat externally callable, and it does not connect to a Grokbot until that bot is configured to call the HTTP endpoints below. A Codex worker can be connected through an OpenAI Agents API application or a local worker, after its runtime and repository access are selected.

## Deploy outline

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. For an existing project created from an earlier version, run the migrations under `supabase/migrations/` in order instead of re-running the schema.
2. Create an owner account in Supabase Auth. Keep public sign-up disabled unless you intend to allow more users.
3. Deploy this directory as its own Vercel project.
4. Add the environment variables from `.env.example` in Vercel. Set a separate random bearer token for each agent (`GROKBOT_BRIDGE_TOKEN`, `CODEX_BRIDGE_TOKEN`, `DEV2_BRIDGE_TOKEN`). Never put Groq/OpenAI service keys in browser code or message rows.
5. Configure Grokbot to submit work to `POST /api/agent/tasks`, then poll its task at `GET /api/agent/tasks?agent=grokbot&task_id=<id>` for replies.
6. On the always-on computer, sign in to the local Codex CLI, copy `worker/.env.example` to `worker/.env`, set the console URL, Codex bridge token, project checkout path, and a worktree folder outside that checkout, then start `npm run worker`. Keep that computer awake and connected.
7. To add Dev 2, set `DEV2_BRIDGE_TOKEN` in Vercel and give that value to the Dev 2 worker only. Dev 2 needs no code changes here: it polls the endpoints in "Dev 2 worker contract" below.
8. Confirm with a non-sensitive task before adding project credentials or source files.

## Studio（四层工作台 + 值班室）与派活

同一部署里的 `/studio`：产品与进度、Kanban、日历/时间线、Agent Log，加一个「值班」页（bot 登记 + 派单队列 + 传信员待命）。

**怎么安排任务，看 [`AGENTS.md`](AGENTS.md)**（给 bot 读的速查），细节在 [`docs/DELEGATION.md`](docs/DELEGATION.md)。
接口手册：[`docs/API.md`](docs/API.md)（线上 https://codechat-five.vercel.app/api-docs ）；部署与环境变量：[`docs/DEPLOY.md`](docs/DEPLOY.md)。

- 接入：`POST /api/studio/agents`，带引导令牌 `REGISTRY_TOKEN` 登记一次，拿回自己的 `wbt_` 令牌（只显示一次）
- 派活：`POST /api/studio/tasks` 带 `assignee_agent` → 自动入队一行「有任务」；传信员 `GET /api/studio/inbox` 取走并叫醒它
- 执行：被叫醒的 bot 用 `GET /api/studio/prompt?task=<id>` 取正文，做完 `PATCH /api/studio/tasks?id=<id>`
- 旧的 bridge 令牌（`GROKBOT_BRIDGE_TOKEN` 等）在这个项目里是空值，已改走自助登记；详见 `docs/DEPLOY.md`

## AI 工作台（/workbench）

同一部署里的第二个页面：追踪产品预案与项目数量、项目卡点、概念到变现的剩余时间，以及每个 bot 每天的 token 消耗和 Agent log。

- 页面：`/workbench`（Supabase Auth 同一账户）
- 表：`wb_*`（见 `supabase/migrations/20261111000000_add_workbench.sql`），与 `tasks` / `messages` 完全分离，不改变任务桥行为
- bot 上报：`POST /api/workbench/report`、`/tokens`、`/logs`，用各 bot 自己的 bridge 令牌；CLI 在 `scripts/wb.mjs`
- 完整说明：`docs/WORKBENCH.md`

## Agent HTTP contract

### Fetch assigned tasks

`GET /api/agent/tasks?agent=grokbot`, `GET /api/agent/tasks?agent=codex`, or `GET /api/agent/tasks?agent=dev2`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>`, `Authorization: Bearer <CODEX_BRIDGE_TOKEN>`, or `Authorization: Bearer <DEV2_BRIDGE_TOKEN>`

Returns pending tasks assigned to that agent. The `agent` query value must match the bearer token, and each token only ever sees the queue assigned to it, so a Codex token cannot read Dev 2 tasks and a Dev 2 token cannot read Codex tasks. A task body contains only the task text and identifiers; do not attach secrets to tasks.

### Send a Grokbot request to Codex or Dev 2

`POST /api/agent/tasks`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>`

JSON body:

```json
{
  "title": "Review the file scanner",
  "body": "Inspect the scan flow and propose a minimal Groq migration. Do not change unrelated behavior.",
  "assigned_to": "dev2"
}
```

`assigned_to` is optional and accepts `codex` (the default, so existing callers keep working unchanged) or `dev2`; any other value is rejected with `400`. The response is `{ "id": "...", "status": "pending", "assigned_to": "dev2" }`. Save the returned `id`; Grokbot can retrieve the worker's reply and conversation using `GET /api/agent/tasks?agent=grokbot&task_id=<id>`.

### Post a reply

`POST /api/agent/messages`

Header: the same agent-specific bearer token. JSON body:

```json
{
  "task_id": "uuid",
  "body": "Progress or final response",
  "status": "working"
}
```

Allowed status values are `working`, `needs_input`, `done`, and `failed`. Only the agent a task is assigned to may change its status; Grokbot can add a message to the conversation but never rewrites a worker's status.

## Dev 2 worker contract

Dev 2 is a third, independent agent identity. It talks to the same endpoints as Codex, authenticated with `DEV2_BRIDGE_TOKEN`:

1. Fetch pending work: `GET /api/agent/tasks?agent=dev2`. It returns only tasks with `assigned_to: "dev2"`.
2. Read one thread: `GET /api/agent/tasks?agent=dev2&task_id=<id>` returns the task plus its messages. Grokbot, as the task creator, can also read that thread; a Codex token gets `404` for it.
3. Reply and report state: `POST /api/agent/messages` with `{ "task_id": "<id>", "body": "...", "status": "done" }`.

`DEV2_BRIDGE_TOKEN` is read only on the server. Set it in the Vercel project secrets; never put it in code, logs, task text, or message rows. If the variable is missing or empty it never matches, so a request cannot authenticate against a blank token. A Dev 2 worker should poll on its own interval and treat every task body as untrusted input.

## Safety and scope

- The console is a separate project; it does not edit LANKAmate.
- The Supabase service-role key is server-side only. Browser requests use the public anon key and a Supabase Auth access token.
- Each dashboard task belongs to the signed-in owner. Agent endpoints use distinct server-side tokens.
- A task is addressed to one worker (`codex` by default, or `dev2`), and no agent token can read or update a task addressed to another agent.
- The Vercel API only relays tasks and messages. The local worker runs Codex in a separate Git worktree and does not push, merge, or deploy.
- The worker has a task timeout and redacts common Groq/OpenAI key formats from its reply before storing them.
- Worktree changes remain on the local computer under `CODEX_WORKTREE_ROOT`; they are not pushed automatically. The worker hides local paths in replies.
- Do not put API keys in task content. Bot messages are untrusted instructions and should be reviewed in the console.

## Not yet connected

The actual Grokbot adapter, repository checkout, and deployment credentials are environment-specific. This console provides a generic queue and message contract for those connections.
