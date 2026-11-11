# AI 工作台（Workbench）

在一个页面上回答四个问题：

1. 现在有多少条产品预案、多少个项目？
2. 项目卡在哪，卡了几天，等谁？
3. 从概念到变现还要多久？（按真实阶段迁移记录估算）
4. 今天有多少项目被推进、多少 token 被空耗、哪个 bot 参与哪个项目、谁还没交 Agent log？

页面：`/workbench`。数据表全部是 `wb_*`，与任务桥的 `tasks` / `messages` 完全分离。

## 边界（为什么可以随时上线）

- 迁移 `supabase/migrations/20261111000000_add_workbench.sql` **只新建**：`create table if not exists`、`create or replace function`，没有 `drop`、没有 `alter` 既有表。
- 线上桥正在使用 `public.tasks` / `public.messages`，本工作台不读也不写它们（`wb_reports.task_id` 是可选外键，`on delete set null`）。
- 新增页面/接口都是新文件，`index.html`、`app.js`、`/api/tasks`、`/api/agent/*` 的行为未变。

## 数据模型

| 表 | 作用 | 关键列 |
|---|---|---|
| `wb_agents` | 参与方 | `id`（grokbot / codex / dev2 / hermes / openbot）、`display_name`、`active` |
| `wb_product_plans` | 产品预案 | `title`、`status`（draft/validated/approved/rejected/converted/archived）、`source_agent`、`project_id` |
| `wb_projects` | 项目 | `stage`、`status`、`owner_agent`、`last_progress_at`、`stage_entered_at`、`monetized_at` |
| `wb_stage_events` | 阶段迁移历史 | `from_stage`、`to_stage`、`created_at`；ETA 的唯一依据 |
| `wb_reports` | bot 进度汇报 | `agent`、`kind`、`summary`、`outcome`、`blocked`、`day` |
| `wb_token_usage` | token 记账 | `agent` × `day` × `project`，`tokens_in/out`、`waste_tokens` + 理由 |
| `wb_agent_logs` | 每日 Agent log | `agent` × `day` 唯一，`log_markdown` |

视图：`wb_project_board`（含 `days_in_stage`、`days_since_progress`、`is_stuck`）、`wb_stage_median`（每阶段耗时中位数）、`wb_agent_daily`（agent × 天汇总）。

一次性取数函数：`wb_overview(p_day)` → `jsonb`，仪表盘只调这一个接口。

## 阶段与状态

阶段顺序（`wb_stage_index` 决定）：`idea 概念 → proposal 预案 → validated 验证 → build 开发 → testing 调试 → launch 上线 → revenue 变现`。

状态：`active 进行中`、`blocked 阻塞`、`paused 暂停`、`done 完成`、`killed 放弃`。

## 指标定义（写死在 SQL 里，改口径改这里）

- **停滞**：`status = blocked / paused`，或 `active` 且 `now() - last_progress_at > 3 天`。
- **今日推进**：当天 `outcome = advanced` 的**不同项目数**（不是汇报条数）。
- **空耗 token**：bot 自己上报的 `waste_tokens`，超过 0 必须给 `waste_reason`，否则记账被拒。另外单独统计"花在停滞项目上的 token"（`spend_on_stalled`），这部分是系统推断，不由 bot 声明。
- **审计标记**：`no_log`（有消耗没交 log）、`spend_no_progress`（花了 token 但今天没推进任何项目）、`declared_waste`、`spend_on_stalled`。
- **ETA（还有几天到变现）**：只统计真正迁出过的阶段；某阶段样本 < 2 次时不给估算，卡片显示"样本不足"。样本足够前 `etaDays` 为 `null`，绝不猜。
- **日界线**：`Asia/Colombo`（主人时区），SQL 默认值与接口默认值一致。

## 接口

两种身份：

- **owner**：Supabase Auth 的 JWT（浏览器登录后用 `/api/config` 拿到项目地址）。
- **agent**：`Authorization: Bearer <AGENT>_BRIDGE_TOKEN`，与任务桥同一套令牌，另加 `HERMES_BRIDGE_TOKEN`、`OPENBOT_BRIDGE_TOKEN`。

| 方法与路径 | 身份 | 说明 |
|---|---|---|
| `GET /api/workbench/overview?day=YYYY-MM-DD` | owner | 仪表盘全部数据 |
| `GET/POST/PATCH /api/workbench/plans` | owner | 预案增改查 |
| `GET/POST/PATCH /api/workbench/projects` | owner（GET 也允许 agent） | 项目增改查；改 `stage` 自动写阶段历史 |
| `GET/POST /api/workbench/report` | POST: agent，GET: owner | 进度/阻塞汇报；上报 `advanced` 自动刷新 `last_progress_at`，`blocked` 自动把项目置为阻塞 |
| `GET/POST /api/workbench/tokens` | POST: agent，GET: owner | token 记账（按 agent×天×项目 upsert） |
| `GET/POST /api/workbench/logs` | POST: agent，GET: owner | 每日 Agent log（按 agent×天 upsert） |
| `GET/POST/PATCH /api/workbench/agents` | owner | 参与方名单 |

### 上报示例

```bash
curl -X POST https://codechat-five.vercel.app/api/workbench/report \
  -H "Authorization: Bearer $DEV2_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project":"Agent Bridge","kind":"progress","summary":"下单表单接通","outcome":"advanced","percent":45}'

curl -X POST .../api/workbench/tokens \
  -H "Authorization: Bearer $DEV2_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"Agent Bridge","tokens_in":120000,"tokens_out":9000,"waste_tokens":15000,"waste_reason":"重复读取同一文件","model":"claude-sonnet"}'

curl -X POST .../api/workbench/logs \
  -H "Authorization: Bearer $DEV2_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"log_markdown":"今天……","projects":["Agent Bridge"],"tasks_done":3}'
```

`project` 可以写项目名（精确匹配）或 uuid；不写就是不归属任何项目的全局消耗。

## bot 侧 CLI

```bash
export WB_BASE_URL=https://codechat-five.vercel.app
export WB_TOKEN=$DEV2_BRIDGE_TOKEN      # 该 bot 自己的令牌

node scripts/wb.mjs status
node scripts/wb.mjs report --project "Prasad Shelf" --kind blocker --summary "缺客服报价接口" --blocked --blocker-owner Prasad
node scripts/wb.mjs token --project "Prasad Shelf" --in 88000 --out 4000 --waste 30000 --reason "在阻塞项上空转"
node scripts/wb.mjs log --file C:/path/to/log.md --projects "Prasad Shelf" --done 2 --failed 1
```

## 本地启动

```bash
cp .env.example .env.local     # 填 SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY / CONSOLE_OWNER_ID
npm install
npm run dev:local              # http://localhost:3120 ，工作台在 /workbench
```

`npm run dev`（`vercel dev`）在这个仓库里用不了：`package.json` 的 `dev` 脚本就是 `vercel dev`，CLI 会判定递归调用并退出。`dev:local` 只做本地静态托管 + 把 `/api/*` 交给真实的 TS handler，够验证用；它不模拟 Vercel 的域名、rewrite 和构建。

## 上线顺序（当前状态：只在本地）

1. **本地**（已完成）：`npm run typecheck`；本地 harness 跑通全部接口；界面在真实数据上渲染过。
2. **Vercel 预览**：`npx vercel deploy`（不带 `--prod`），在预览域上再点一遍。
3. **线上**：确认预览无问题后推 `main`。推之前要在 Vercel 项目里加 `HERMES_BRIDGE_TOKEN`、`OPENBOT_BRIDGE_TOKEN`（sensitive），否则这两个 bot 上报会 401；已有三个令牌无需改动。
4. 部署后跑一次 `node scripts/wb.mjs status` 证明线上读取正常。

回滚：本工作台不碰既有对象，最坏情况是删掉 `wb_*` 表/视图/函数和 `workbench.html|js|css`、`api/workbench/`；任务桥不受影响。

## 还没做

- **token 数不是自动采集的**：目前靠 bot 自报。Hermes / Codex 的会话用量可以从各自日志里抓，Grokbot 和 OpenBot 需要它们自己报；没有采集器的 bot 会显示"未交 log"。
- **每天结束的追查**不是定时任务：需要一个 cron/定时器在收盘时提醒未交 log 的 bot。建议下一步加 `cron` → 调 `/api/workbench/overview` → 给缺 log 的 agent 发任务。
- **没有删除接口**：预案/项目只能归档或标 `killed`，要彻底删除得用 SQL。
- 阶段中位数需要真实迁移记录；新项目第一周只能看到"样本不足"。
