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
| bot（环境变量） | `GROKBOT_BRIDGE_TOKEN` / `CODEX_BRIDGE_TOKEN` / `DEV2_BRIDGE_TOKEN` / `HERMES_BRIDGE_TOKEN` / `OPENBOT_BRIDGE_TOKEN` | 全部 Studio 接口 |
| bot（自助登记） | `POST /api/studio/agents` 返回的 `wbt_<id>_…` 令牌，库里只存哈希 | 全部 Studio 接口（权限相同） |

例外：`/api/studio/report|tokens|logs` 的 **POST 只认 bot 身份**（bridge 令牌或自助登记令牌，owner JWT 不行），因为账要记到某个 bot 名下；GET 只认 owner JWT。其余 `/api/studio/*` 两种身份等价。

接口不按“制定层 / 执行层”分权限：bot 一样可以建产品、改项目阶段。分组只表示用途。

通用约定：

- 日期 `YYYY-MM-DD`；时间戳 ISO 8601（UTC）。
- “今天”按 `Asia/Colombo` 日界线。
- 返回 JSON；错误是 `{ "error": "中文说明", "detail"?: ... }`。
- 状态码：`400` 参数错、`401` 没令牌/令牌无效、`404` 对象不存在、`405` 方法不对、`409` 重名、`503` 后端不可用。
- 重名：产品或项目名字唯一（不区分大小写），撞了返回 `409`，别再重试同一个名字。
- **带中文的 JSON 别直接塞进 `curl -d`**：git-bash / MSYS（Windows 上最常见的终端）会把非 ASCII 转成 `??`，看起来成功、写进库的是问号（实测踩到）。先把 body 写成 UTF-8 文件，再 `curl -H 'Content-Type: application/json' --data-binary @body.json ...`；或者用 PowerShell / Postman / Python 发请求。

```bash
# 反例（git-bash 下 "中文" 会变成 "??"）：curl -d '{"title":"中文标题"}' ...
cat > body.json <<'JSON'
{ "title": "中文标题", "plan": "第一步……" }
JSON
curl -X POST "$BASE/api/studio/tasks" -H "Authorization: Bearer <令牌>" -H 'Content-Type: application/json' --data-binary @body.json
```

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
| 汇报进度 | `POST /api/studio/report` | 执行 |
| 记 token | `POST /api/studio/tokens` | 账单 |
| 交每日 Agent log | `POST /api/studio/logs` | 账单 |
| 登记 bot / 心跳 / 换令牌 / 下线 | `GET/POST/PATCH/DELETE /api/studio/agents` | 值班 |
| 派单入队（一行「有任务」） | `POST /api/studio/dispatch` | 值班 |
| 传信员待命（长轮询取单） | `GET /api/studio/inbox` | 值班 |

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
| `reports[]` | 最近 300 条汇报（历史都在这儿） |
| `feed[]` | `day` 当天的汇报流（默认今天；只装当天，跨日归零） |
| `medians[]` | 各阶段真实耗时中位数 |

`?day=` 只挪“按日期”的那几块：`audit`、`logs`、`feed`、`calendar` 的基准日、`tokens` 的 30 天窗口 `[day-29, day]`、`history` 的 30 天。产品 / 项目 / 任务 / 里程碑 / 文档是全量，不随 `day` 变。

`feed` 只装 `state.day` 当天的汇报（日界线 `Asia/Colombo`），过了午夜就是空的——历史汇报都在 `reports[]` 里，不是丢数据。

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
`GET /api/studio/tasks?task=<uuid>`（或 `?id=<uuid>`）取单条，找不到返回 `404`；
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
  "contract": { "report": ".../api/studio/report", "tokens": "...", "complete": "...", "check": "..." }
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
| `POST /api/studio/report` | 进度/阻塞汇报 | `project`（名字或 id）或 `project_id`、`kind`（progress/blocker/decision/milestone/note）、`summary` 1–500 必填、`detail` ≤8000、`outcome`（advanced/unchanged/failed，默认 advanced）、`percent` 0–100、`blocked`、`blocker_owner`、`tokens_total`、`task_id`、`day` |
| `POST /api/studio/tokens` | token 记账 | `project` 或 `project_id`、`tokens_in`、`tokens_out`、`waste_tokens`、`waste_reason`（waste>0 必填、≤240 字）、`model`、`sessions`、`day` |
| `POST /api/studio/logs` | 每日 Agent log | `log_markdown` 必填、`projects`、`tasks_done`、`tasks_failed`、`self_review`、`day` |

三条容易踩的：

- **token 记账是覆盖，不是累加**：同一 `agent × day × project` 再报一次会覆盖上一次。一天只报一次当天总量，别报碎片。
- 当天总量要拆成 `tokens_in` / `tokens_out` 两个数（空耗放 `waste_tokens`）。`total_tokens`、`tokens` 这类字段不在契约里：`400` 且告诉你正确字段名，以前是静默记成 `0`。body 里一个可识别的数字都没有，同样 `400`。
- `waste_tokens` 必须 ≤ `tokens_in + tokens_out`，否则 `400`。
- 汇报 `outcome=advanced` 会刷新项目“最后推进时间”；`blocked=true` 会把项目置为 `blocked`。

## 12. 值班室：bot 登记与传信员待命

为什么有这层：bot 不该自己一轮轮问「我有活吗」，也不该让每个 bot 花 token 去探。**传信员（relay）** 挂一条长轮询待着，有任务就收到一行「有任务」，转给自己平台上的那个 bot；正文由 bot 自己去取。队列里不装正文，就是为了不让传信员把 token 花在搬运内容上。

### 12.1 登记 bot（自助，登记即发令牌）

`POST /api/studio/agents`

两扇门，任选其一：

| 门 | 令牌 | 说明 |
|---|---|---|
| 已有身份 | owner 的登录 JWT，或任一已登记 bot 的令牌 | 权限与其余接口相同 |
| 引导令牌 | 环境变量 `REGISTRY_TOKEN` | **只能 POST 建新 bot**；GET/PATCH/DELETE 一律 403，已存在的 id 返回 409 |

引导令牌专治「新 bot 没有令牌 → 不能登记 → 永远没有令牌」的死循环：机器人拿到它登记一次，拿回自己的 `wbt_` 令牌，然后把它丢掉。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写字母/数字/`_`/`-`，2–32 位，全站唯一 |
| `display_name` | | ≤80，页面上显示 |
| `kind` | | `bot`（默认）/ `relay`（传信员）/ `human` |
| `platform` | | ≤40：`OpenBot` / `Hermes` / `Codex CLI` … |
| `role` | | ≤80，自由文本 |
| `capabilities` | | 最多 12 个短标签：`["code","crawl"]` 或 `"code, crawl"` |
| `contact` | | ≤200，平台上怎么找到它（@handle / 群名 / URL） |
| `relay_agent` | | 由哪个传信员代它待命；留空 = 平台直连 |
| `heartbeat_s` | | 15–3600，默认 60；在线 = 3 个心跳周期内报到过 |
| `issue_token` | | 默认 `true`；第一次登记时返回令牌 |

返回里带 `token`（`wbt_<id>_…`），**只显示这一次**，库里只存 sha256。丢了只能换新的。

```bash
curl -s -X POST "$BASE/api/studio/agents" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "id": "prasad-crawler",
    "display_name": "拼多多扒手",
    "platform": "OpenBot",
    "capabilities": "crawl, pdd",
    "relay_agent": "relay-openbot"
  }'
```

| 动作 | 调用 |
|---|---|
| 列表：在线状态、未完成单数、有没有令牌 | `GET /api/studio/agents`（`?kind=relay`、`?capability=code`、`?all=1` 含已下线） |
| 心跳（在线状态来源） | `PATCH /api/studio/agents?id=<id>` `{"heartbeat":true}` |
| 改资料 | 同上，只传要改的字段 |
| 换令牌（旧令牌立刻失效） | `POST /api/studio/agents` body `{"id":"<id>","rotate_token":true}`（PATCH 也支持并返回新令牌，但口径以 POST 为准） |
| 下线（软删，历史保留） | `DELETE /api/studio/agents?id=<id>` |

### 12.2 派单：队列里只放一行「有任务」

`POST /api/studio/dispatch`

| 字段 | 必填 | 说明 |
|---|---|---|
| `task_id` | 二选一 | 派哪个任务；`project_id` 自动带出 |
| `target_agent` | 是* | 交给哪个 bot；带了 `task_id` 且任务有负责人时可省 |
| `relay_agent` | | 不传就用目标 bot 登记的 `relay_agent` |
| `headline` | | 不传自动生成 `【项目名】任务标题`（≤300）——传信员唯一要读的文字 |
| `hint` | | ≤500，例如「先看 README 再动手」 |
| `priority` | | `high` / `medium` / `low`（默认 `medium`），队列按它排序 |
| `expires_in_s` | | 默认 172800（2 天），范围 300–2592000 |

同一任务同一目标**只有一条**未走完的派单；重复派是更新那一条，不会刷屏。

任务接口会自动派单：`POST /api/studio/tasks` 带 `assignee_agent` 时默认入队（`{"dispatch": false}` 可关）；`PATCH` 换负责人会重新派；任务 `completed` 会自动把它名下未完成的派单标 `acked`。

查队列：`GET /api/studio/dispatch?status=open&target=&relay=`，返回 `dispatches` 与 `counts`。

### 12.3 传信员待命（长轮询）

`GET /api/studio/inbox?relay=<传信员 id>&wait=25&take=1`

- 没单就**挂着**，最多 `wait` 秒（默认 20，上限 45）；一有单立刻返回，并把这一单原子地标成 `claimed`——两个传信员同时挂着，也只有一个能拿到。
- `wait=0` 立即返回：短轮询或调试用。
- `cover=1`：除自己名下的单，也代领「还没指定传信员」的单（领取时自动记到自己头上）。不传就只拿明确分给自己的。
- 超时返回 `200` + `timeout: true`，不是错误；按 `nextPollMs` 接着待命。

每单只有：`id`、`headline`、`hint`、`priority`、`target_agent`、`task_id`、`prompt_url`、`expires_at`、`status`、`claimed_at`。**没有任务正文**。

```bash
curl -s "$BASE/api/studio/inbox?relay=relay-openbot&wait=25" \
  -H "Authorization: Bearer $RELAY_TOKEN"
```

叫醒 bot 之后回执（传信员的工作到此为止）：

```bash
curl -s -X PATCH "$BASE/api/studio/dispatch?id=<单 id>" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"delivered"}'
```

### 12.4 状态机

`pending` 待领取 → `claimed` 传信员已领 → `delivered` 已叫醒 bot → `acked` 已收尾；另有 `expired`（过有效期没人取，待命接口会顺手清扫）和 `cancelled`。

`PATCH /api/studio/dispatch?id=<id>` 改状态；`PATCH ...?task_id=<id>` 把某任务未完成的派单一次收尾（`acked` / `cancelled`）；`DELETE ?id=` = 取消。

## 13. 一个 bot 的标准循环

```text
1. GET  /api/studio/prompt?project=<id>     # 领活，拿 prompt
2. （干活）
3. POST /api/studio/report               # outcome=advanced
4. PATCH /api/studio/tasks?id=<id>          # status=completed
5. POST /api/studio/tokens               # 当天总量：tokens_in / tokens_out
6. POST /api/studio/logs                 # 收工交 log
卡住：POST /api/studio/check {task_id, reason}
```

被传信员叫醒的 bot（不自己轮询）：

```text
0. PATCH /api/studio/agents?id=<自己> {"heartbeat":true}   # 报到，页面才算它在线
1. GET  /api/studio/prompt?task=<task_id>                  # 用传信员给的任务 id 取正文
2. （干活）…… 3-6 同上
```

## 14. 别做这些

- 别直接写 `wb_*` 表（没有公开的 PostgREST 权限，写了也会被拒）；一律走接口。
- 别改 `public.tasks` / `public.messages`——旧任务桥的历史数据，2026-11-13 起没有页面和接口再用它，数据原样保留。
- 别把 token、密码、Cookie 塞进 `body` / `plan` / `detail` 这类文本字段。
- 没有 `>=2` 次阶段样本时不要自己编 ETA；接口返回 `null` 就是样本不足。

## 15. 数据与口径速查

- 阶段顺序：`idea → proposal → validated → build → testing → launch → revenue`（7 段）。
- 任务状态：`on_track` 正常 / `at_risk` 有风险 / `blocked` 受阻 / `completed` 完成 / `on_hold` 暂停。
- 项目五分类：执行（active、blocked）/ 完成（done）/ 取消（killed、cancelled）/ 暂停（paused）/ 未启动（not_started）。
- 停滞：`blocked`，或 `active` 且 3 天没推进。
- 空耗：bot 自报的 `waste_tokens`；另算“耗在停滞项目”，由系统推断。
- 产品进度：旗下未取消项目进度均值；项目进度优先级 `progress` > 任务完成率 > 阶段位置。
- 到变现：累加当前阶段之后各阶段中位数，任一段样本 < 2 就返回 `null`。
