# Studio API · bot 调用手册

给所有 bot（Grokbot / Codex / Dev 2 / Hermes / OpenBot）看的接口手册。每个功能一节：能干什么、调哪个接口、参数、返回、出错怎么处理。

- 本地 base：`http://localhost:3120`
- 机器可读清单：`GET /api/studio/manifest`
- 本文件在线版（本地）：`http://localhost:3120/api-docs`

## 0. 身份与规矩

```http
Authorization: Bearer <token>
Content-Type: application/json
```

两种令牌对 **`/api/studio/*`** 权限完全相同：

| 身份 | 令牌来源 | 能做什么 |
|---|---|---|
| owner | Supabase 登录后的 JWT | 全部（含页面） |
| bot | `GROKBOT_BRIDGE_TOKEN` / `CODEX_BRIDGE_TOKEN` / `DEV2_BRIDGE_TOKEN` / `HERMES_BRIDGE_TOKEN` / `OPENBOT_BRIDGE_TOKEN` | 全部 Studio 接口 |

例外：旧的 `/api/workbench/report|tokens|logs` 是 **POST 只认 bot 令牌**、GET 只认 owner JWT；bot 上报用 bot 令牌就对了。

接口不按“制定层 / 执行层”分权限：bot 一样可以建产品、改项目阶段。分组只表示用途。

通用约定：

- 日期 `YYYY-MM-DD`；时间戳 ISO 8601（UTC）。
- “今天”按 `Asia/Colombo` 日界线。
- 返回 JSON；错误是 `{ "error": "中文说明", "detail"?: ... }`。
- 状态码：`400` 参数错、`401` 没令牌/令牌无效、`404` 对象不存在、`405` 方法不对、`409` 重名、`503` 后端不可用。
- 重名：产品或项目名字唯一（不区分大小写），撞了返回 `409`，别再重试同一个名字。

## 1. 功能索引

| 想做的事 | 接口 | 层 |
|---|---|---|
| 拿整站数据（产品/项目/任务/日程/token） | `GET /api/studio/state` | 全部 |
| 查接口清单 | `GET /api/studio/manifest` | 全部 |
| 建/改产品 | `POST/PATCH /api/studio/products` | 制定 |
| 建/改项目、改阶段与进度 | `POST/PATCH /api/studio/projects` | 制定 |
| 建/改任务、改状态、挂子任务、删任务 | `POST/PATCH/DELETE /api/studio/tasks` | 制定+执行 |
| 建/改里程碑 | `POST/PATCH /api/studio/milestones` | 制定 |
| 建/改/删日程 | `POST/PATCH/DELETE /api/studio/schedule` | 制定 |
| 写研究/规划文档 | `POST /api/studio/docs` | 制定 |
| 领活：拿执行摘要 prompt | `GET /api/studio/prompt` | 执行 |
| 卡住/要人看：申请检查 | `POST /api/studio/check` | 执行 |
| 汇报进度 | `POST /api/workbench/report` | 执行 |
| 记 token | `POST /api/workbench/tokens` | 账单 |
| 交每日 Agent log | `POST /api/workbench/logs` | 账单 |

## 2. 全站数据 `GET /api/studio/state`

参数：`day=YYYY-MM-DD`（可选，默认今天；影响“今日 token/汇报/日历基准”）。

返回的顶层字段：

| 字段 | 内容 |
|---|---|
| `day` | 基准日期 |
| `agents` | 参与方名单 |
| `products[]` | 产品 + `progressPct`、`etaDays`（可能 null）、`projectIds[]`、`stuckProjects`、`docs[]` |
| `projects[]` | 项目 + `progressPct`、`taskCount/taskDone`、`participants[]`、`currentTask`、`tasks[]`、`milestones[]`、`docs[]`、`etaDays` |
| `tasks[]` | 扁平任务列表（含 `projectName`、`productId`、`assigneeName`） |
| `schedule[]`、`calendar{}` | 日程与按天分组 |
| `events[]` | 时间线节点（任务/里程碑/日程，含 `ownerRequired`） |
| `completedByDay{}` | 过去每天完成的东西 |
| `tokens{byAgent,byProject,byModel,byDay}` | 近 30 天 token |
| `audit[]`、`unaudited[]` | 当日审计与未交 log |
| `history[]` | 30 天趋势（tokens / waste / advances / completed） |
| `medians[]` | 各阶段真实耗时中位数 |

## 3. 产品

`POST /api/studio/products` 建，`PATCH /api/studio/products?id=<uuid>` 改，`GET` 列表。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string ≤180 | 建时必填 | 唯一 |
| `summary` | string ≤8000 | | 产品综述 |
| `plan` | string ≤8000 | | 产品规划 |
| `research` | string ≤12000 | | 调研汇报（纯文本） |
| `target_user` | string ≤240 | | 目标用户 |
| `monetization_model` | string ≤240 | | 变现方式 |
| `status` | `active`/`paused`/`done`/`killed` | | 默认 `active` |
| `owner_agent` | `dev2` 等 | | 负责人 |
| `target_monetized_at` | date | | 计划变现日 |
| `price_hypothesis` | number ≥0 | | 价格假设 |

```bash
curl -X POST "$BASE/api/studio/products" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Prasad Shelf","summary":"拼多多选品到斯里兰卡","monetization_model":"加价转售","owner_agent":"dev2"}'
```

## 4. 项目

`POST /api/studio/projects` 建，`PATCH /api/studio/projects?id=<uuid>` 改，`GET`（`?status=`、`?product=`）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string ≤180 | 唯一 |
| `product_id` | uuid | 挂到哪个产品（可空） |
| `stage` | `idea`/`proposal`/`validated`/`build`/`testing`/`launch`/`revenue` | 改它会写阶段历史，用于 ETA |
| `status` | `not_started`/`active`/`blocked`/`paused`/`done`/`killed`/`cancelled` | 五分类：active+blocked=执行，done=完成，killed/cancelled=取消，paused=暂停，not_started=未启动 |
| `category` / `purpose` / `plan` / `summary` | string | 分类 / 目的 / 规划 / 综述 |
| `progress` | 0–100 | 显式进度，优先于任务完成率 |
| `priority` | `high`/`medium`/`low` | |
| `owner_agent` | agent id | |
| `repo_url` / `preview_url` | string ≤500 | |
| `blocked_reason` / `blocker_owner` | string | 卡点与等谁 |
| `monthly_revenue` | number ≥0 | |
| `target_launch_at` | date | |

```bash
curl -X PATCH "$BASE/api/studio/projects?id=$PID" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"stage":"testing","progress":65,"progress_note":"本地接口全通"}'
```

改 `stage` 时带 `progress_note` 会写进阶段历史备注。

## 5. 任务（Kanban 实体）

`GET /api/studio/tasks?project=<uuid>&status=<status>` 列表；
`POST` 建；`PATCH ?id=` 改；`DELETE ?id=` 删（子任务与历史一起删）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | **必填** |
| `parent_id` | uuid | 有值就是子任务 |
| `title` | string ≤200 | 必填 |
| `plan` | string ≤8000 | 任务规划（步骤/验收/不要做什么） |
| `status` | `on_track`/`at_risk`/`blocked`/`completed`/`on_hold` | 默认 `on_track` |
| `priority` | `high`/`medium`/`low` | |
| `assignee_agent` | agent id | 接手 AI |
| `requester_agent` | agent id | 谁派的；bot 建任务时默认自己 |
| `owner_required` | bool | true = 必须主人亲手做，会进日历深蓝块 |
| `progress` | 0–100 | 改 `completed` 会自动置 100 |
| `start_at` / `due_at` | date | 甘特/日历用 |
| `blocked_reason` | string ≤400 | |
| `order_index` | int | 同列排序 |
| `note` | string ≤400 | 只在 PATCH 用，写进任务历史 |

行为：

- 改 `status` 自动写 `wb_task_events`（含 `from_status`/`to_status`）。
- 置 `completed` 记 `completed_at`，并出现在日历“过去完成”。
- 拖看板 = 同一个 PATCH（界面传 `note:"看板拖动"`）。

```bash
# bot 领活后建子任务
curl -X POST "$BASE/api/studio/tasks" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'$PID'","parent_id":"'$TID'","title":"先备份 Cookie","assignee_agent":"dev2"}'

# 交任务
curl -X PATCH "$BASE/api/studio/tasks?id=$TID" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"status":"completed","note":"已上架，见预览"}'
```

## 6. 里程碑

`POST /api/studio/milestones`，`PATCH ?id=`，`GET ?project=`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | 必填 |
| `title` | string ≤200 | 必填 |
| `due_at` | date | 必填 |
| `done_at` | date | 有值=已完成 |
| `owner_required` | bool | 需要主人拍板（甘特深蓝环、日历深蓝块） |
| `note` | string ≤400 | |

## 7. 日程

`POST /api/studio/schedule`，`PATCH ?id=`，`DELETE ?id=`，`GET ?from=&to=`（默认前 31 天到后 61 天）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string ≤200 | 必填 |
| `day` | `YYYY-MM-DD` | 只给日期时落 09:00（科伦坡） |
| `start_at` / `end_at` | ISO 或 date | `start_at` 优先 |
| `detail` | string ≤4000 | |
| `project_id` / `product_id` | uuid | 可空 |
| `kind` | `work`/`review`/`decision`/`owner`/`milestone`/`payment` | `kind=owner` 自动 `owner_required` |
| `owner_required` | bool | 必须主人亲手做 |
| `agent` | agent id | 默认调用者 |
| `done` | bool | 打勾完成 |

## 8. 文档（研究 / 规划）

`POST /api/studio/docs`，`GET ?project=` 或 `?product=`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string ≤240 | 必填 |
| `project_id` 或 `product_id` | uuid | 至少一个 |
| `kind` | `research`/`spec`/`report`/`note` | |
| `url` | string ≤800 | 外链（GitHub 文件、Notion 等） |
| `body` | string ≤20000 | 正文纯文本 |
| `agent` | agent id | |

## 9. 执行层：领任务 `GET /api/studio/prompt`

参数：`task=<uuid>` 或 `project=<uuid>`（给项目时自动取最该做的那条未完成任务）。

返回：

```json
{
  "taskId": "...", "projectId": "...", "productId": "...",
  "task": { "...": "任务全字段" },
  "prompt": "# 任务执行摘要 · ...（可直接塞进上下文）",
  "contract": { "report": ".../api/workbench/report", "tokens": "...", "complete": "...", "check": "..." }
}
```

`prompt` 里已经写好项目目的/规划/综述、子任务、里程碑和回传命令，bot 拿到直接用。

## 10. 执行层：申请检查 `POST /api/studio/check`

```json
{ "task_id": "<uuid>", "reason": "蓝叠里 PDD 没登录", "day": "2026-11-12" }
```

`project_id` 可以替代 `task_id`。效果：

1. 任务从 `on_track` 变 `at_risk`（已经是 `blocked` 就保持），写任务历史。
2. 在日程里建一条 `kind=review`、`owner_required=true` 的检查项（默认明天 09:00）。
3. 写一条 `wb_reports`（`kind=decision`，`source=studio-check`）。

返回 `{ ok, taskId, projectId, reviewAt, review, report }`。

## 11. 汇报与账单（沿用旧接口）

| 接口 | 用途 | 关键字段 |
|---|---|---|
| `POST /api/workbench/report` | 进度/阻塞汇报 | `project`（名字或 id）或 `project_id`、`kind`（progress/blocker/decision/milestone/note）、`summary` 1–500 必填、`detail` ≤8000、`outcome`（advanced/unchanged/failed，默认 advanced）、`percent` 0–100、`blocked`、`blocker_owner`、`tokens_total`、`task_id`、`day` |
| `POST /api/workbench/tokens` | token 记账 | `project` 或 `project_id`、`tokens_in`、`tokens_out`、`waste_tokens`、`waste_reason`（waste>0 必填、≤240 字）、`model`、`sessions`、`day` |
| `POST /api/workbench/logs` | 每日 Agent log | `log_markdown` 必填、`projects`、`tasks_done`、`tasks_failed`、`self_review`、`day` |

三条容易踩的：

- **token 记账是覆盖，不是累加**：同一 `agent × day × project` 再报一次会覆盖上一次。一天只报一次当天总量，别报碎片。
- `waste_tokens` 必须 ≤ `tokens_in + tokens_out`，否则 `400`。
- 汇报 `outcome=advanced` 会刷新项目“最后推进时间”；`blocked=true` 会把项目置为 `blocked`。

## 12. 一个 bot 的标准循环

```text
1. GET  /api/studio/prompt?project=<id>     # 领活，拿 prompt
2. （干活）
3. POST /api/workbench/report               # outcome=advanced
4. PATCH /api/studio/tasks?id=<id>          # status=completed
5. POST /api/workbench/tokens               # 当天总量
6. POST /api/workbench/logs                 # 收工交 log
卡住：POST /api/studio/check {task_id, reason}
```

## 13. 别做这些

- 别直接写 `wb_*` 表（没有公开的 PostgREST 权限，写了也会被拒）；一律走接口。
- 别改 `public.tasks` / `public.messages`——那是线上任务桥的。
- 别把 token、密码、Cookie 塞进 `body` / `plan` / `detail` 这类文本字段。
- 没有 `>=2` 次阶段样本时不要自己编 ETA；接口返回 `null` 就是样本不足。

## 14. 数据与口径速查

- 阶段顺序：`idea → proposal → validated → build → testing → launch → revenue`（7 段）。
- 任务状态：`on_track` 正常 / `at_risk` 有风险 / `blocked` 受阻 / `completed` 完成 / `on_hold` 暂停。
- 项目五分类：执行（active、blocked）/ 完成（done）/ 取消（killed、cancelled）/ 暂停（paused）/ 未启动（not_started）。
- 停滞：`blocked`，或 `active` 且 3 天没推进。
- 空耗：bot 自报的 `waste_tokens`；另算“耗在停滞项目”，由系统推断。
- 产品进度：旗下未取消项目进度均值；项目进度优先级 `progress` > 任务完成率 > 阶段位置。
- 到变现：累加当前阶段之后各阶段中位数，任一段样本 < 2 就返回 `null`。
