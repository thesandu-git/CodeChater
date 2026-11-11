# Studio（本地四层工作台）

地址：`http://localhost:3120/studio`（`npm run dev:local` 起，只在本机可访问）

四层：

| 层 | 看什么 | 给谁用 |
|---|---|---|
| 第一层 产品与进度 | 产品（环形图 = 离变现距离，悬停展开）、项目按 执行/完成/取消/暂停/未启动 分类、项目弹窗（参与 bot、当前任务、甘特+里程碑、目的/规划/综述、研究文档） | Prasad 看全局 |
| 第二层 Kanban | 所有任务的五档状态：正常推进 / 有风险 / 受阻 / 完成 / 暂停；任务弹窗含规划、接手 AI、子任务 | Prasad + bot 找活 |
| 第三层 日历 / 时间线 | 月历（深蓝 = 必须主人亲手做或把关）、过去每天完成了什么；时间线 = 每个项目一条线 + 节点 | Prasad 排自己的时间 |
| 第四层 Agent Log | 当日 token 按 bot / 项目 / 来源（模型）分布、空耗、审计标记、项目推进一览、Agent log 原文 | 对账 |

配色变量在 `studio.css` 顶部：淡绿 `--light:#e9f6ee`、浓绿 `--green:#1d7a4a` / `--deep:#0f4f34`、海军蓝 `--navy:#0e2444`。

## 数据：只加表，不碰线上桥

迁移：`supabase/migrations/20261111010000_add_studio.sql`（可重复执行）。

| 表 | 作用 |
|---|---|
| `wb_products` | 产品：综述、规划、调研、目标用户、变现方式 |
| `wb_projects` | 加列：`product_id`、`category`、`purpose`、`plan`、`progress`、`priority`；`status` 增加 `not_started` |
| `wb_tasks` | 任务/子任务：`parent_id`、`status`（on_track/at_risk/blocked/completed/on_hold）、`assignee_agent`、`owner_required`、`start_at`/`due_at` |
| `wb_task_events` | 任务状态变化历史（时间线、检查申请都写这里） |
| `wb_milestones` | 甘特图上的里程碑，`owner_required` 表示要主人拍板 |
| `wb_schedule` | 日程：`kind`、`owner_required`、`done` |
| `wb_docs` | 研究/规划文档，挂项目或产品 |
| `wb_studio_projects`（视图） | 项目 + 产品名 + 任务计数 + 停滞判定 |

原有 `wb_agents` / `wb_reports` / `wb_token_usage` / `wb_agent_logs` / `wb_stage_events` 继续用。

## 接口：制定层与执行层，但没有权限边界

所有接口接受 **任一** 身份：owner 的 Supabase JWT，或 bot 的 bridge 令牌（`AGENT_TOKENS`：grokbot / codex / dev2 / hermes / openbot）。
“制定层 / 执行层”只是用途分组，代码里不按角色拦：OpenBot 的 bot 同样能建产品、改项目阶段。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/studio/state?day=YYYY-MM-DD` | 整站数据（一次取全） |
| GET | `/api/studio/manifest` | 给 AI 自发现的接口清单 |
| GET/POST/PATCH | `/api/studio/products` | 产品；PATCH `?id=` |
| GET/POST/PATCH | `/api/studio/projects` | 项目；PATCH `?id=`，改阶段自动写阶段历史 |
| GET/POST/PATCH/DELETE | `/api/studio/tasks` | 任务；`?project=`、`?status=`；改状态写 `wb_task_events` |
| GET/POST/PATCH | `/api/studio/milestones` | 里程碑；`due_at=YYYY-MM-DD` |
| GET/POST/PATCH/DELETE | `/api/studio/schedule` | 日程；`owner_required=true` 进“你要亲手做” |
| GET/POST | `/api/studio/docs` | 研究/规划文档 |
| GET | `/api/studio/prompt?task=<id>` 或 `?project=<id>` | **执行层**：生成可直接塞进上下文的执行摘要 prompt |
| POST | `/api/studio/check` | **执行层**：申请检查 `{task_id\|project_id, reason, day?}`，会把任务标成有风险并在日程里放一条主人检查项 |
| POST | `/api/workbench/report` / `tokens` / `logs` | 原有上报接口，继续用 |

### 例子

```bash
TOKEN=...   # 任一 bridge 令牌
BASE=http://localhost:3120

# bot 领活：拿执行摘要 prompt
curl -s "$BASE/api/studio/prompt?project=<project-id>" -H "Authorization: Bearer $TOKEN"

# bot 建任务（制定层也能做）
curl -s -X POST "$BASE/api/studio/tasks" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<uuid>","title":"补 PDD 登录态","assignee_agent":"dev2","due_at":"2026-11-14","priority":"high"}'

# bot 交任务
curl -s -X PATCH "$BASE/api/studio/tasks?id=<uuid>" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"status":"completed"}'

# 卡住 → 申请检查
curl -s -X POST "$BASE/api/studio/check" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"task_id":"<uuid>","reason":"蓝叠里 PDD 没登录"}'
```

## 口径

- **产品进度**：产品下未取消项目的进度均值；单项目进度优先用显式 `progress`，否则用任务完成率，再否则用阶段位置。
- **到变现天数**：只累加“当前阶段之后”的阶段中位数；任一段样本 < 2 次就返回 `null`（界面显示“样本不足”），不猜。产品取旗下项目里最慢的那个。
- **停滞**：`blocked`，或 `active` 且 3 天没推进。
- **审计标记**：`no_log` / `spend_no_progress` / `declared_waste` / `spend_on_stalled`，定义见 `docs/WORKBENCH.md`。
- **日界线**：`Asia/Colombo`。

## 本地验证方式

```bash
npm run dev:local     # http://localhost:3120/studio
npm run typecheck
```

`scripts/dev-local.mjs` 只做静态文件 + 动态 import handler；`vercel dev` 会递归调用，别用。

## 现在的状态

- 站点、接口、迁移都只在本地 `workbench` 分支，**没有 push、没有部署**；线上 `codechat-five.vercel.app` 仍是旧的。
- 初始数据（3 个产品 / 3 个项目 / 10 条任务 / 6 个里程碑 / 4 条日程 / 2 篇文档）是按已知情况手工填的，不是编造的业务数据；阶段、进度、日程按需在页面上改。
