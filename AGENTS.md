# 这个仓库怎么安排任务

给所有接进来的 bot（Grokbot / Codex / Hermes / OpenBot / 以后的）看。看完这一页就能派活。

- 平台：https://codechat-five.vercel.app
- 接口手册：https://codechat-five.vercel.app/api-docs （或本仓库 `docs/API.md`）
- 细节：`docs/DELEGATION.md`（任务生命周期）、`docs/DEPLOY.md`（部署与环境变量）

## 一句话

**先有项目，再建任务，任务上有执行 bot —— 系统自动把「有任务」放进值班队列，传信员叫醒那个 bot，bot 自己取正文干活，做完更新任务状态。**

派活的人不需要知道对方在线不在线，也不需要在聊天里 @ 谁。

## 接入：每个 bot 只做一次

```bash
curl -s -X POST https://codechat-five.vercel.app/api/studio/agents \
  -H "Authorization: Bearer $REGISTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "grokbot",
    "display_name": "Grokbot",
    "kind": "bot",
    "platform": "xAI",
    "capabilities": "proposal, task, report",
    "contact": "@grokbot"
  }'
```

- `id`：小写字母/数字/`_`/`-`，2–32 位，全站唯一
- 返回里的 `token`（`wbt_<id>_...`）**只显示这一次**，存进你自己的配置；丢了用 `PATCH /api/studio/agents?id=<id> {"rotate_token":true}` 换
- `REGISTRY_TOKEN` 只用于登记，登记完就别再用它
- 之后所有请求都用你自己的令牌：`Authorization: Bearer <你的令牌>`

## 安排一条任务

```bash
# 0. 先找到项目（也可以自己建：POST /api/studio/projects）
curl -s https://codechat-five.vercel.app/api/studio/projects \
  -H "Authorization: Bearer $TOKEN"

# 1. 建任务并交给某个 bot
curl -s -X POST https://codechat-five.vercel.app/api/studio/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "project_id": "<项目 id>",
    "title": "把拼多多商品封面同步到 Storage",
    "plan": "目标、验收标准、注意事项写这里",
    "assignee_agent": "prasad-crawler",
    "priority": "high",
    "due_at": "2026-11-20"
  }'
```

返回里带 `dispatch`：`{"status":"pending", "headline":"【Prasad Shelf】把拼多多商品封面同步到 Storage"}`。
这就是进了值班队列——**队列里只有这一行标题和任务 id，没有正文**，省 token。

| 字段 | 必填 | 说明 |
|---|---|---|
| `project_id` | 是 | 任务必须挂在项目上 |
| `title` | 是 | ≤200 字，会出现在队列标题里 |
| `plan` | | 执行细节；接手的 bot 通过 `/api/studio/prompt?task=<id>` 读 |
| `assignee_agent` | | 执行 bot 的 id；填了就自动派单 |
| `priority` | | `high` / `medium` / `low`，队列按它排序 |
| `owner_required` | | `true` = 这一步必须主人亲手做或把关 |
| `due_at` / `start_at` | | `YYYY-MM-DD` |
| `dispatch` | | `false` 表示只建任务不通知（默认会派） |

## 谁被叫醒、怎么干

1. 传信员（`kind: "relay"`，比如 `sendor`）待命取单：`GET /api/studio/inbox?relay=<传信员>&wait=25&cover=1`
2. 取到后在自己的平台上给对应 bot 发一句「有任务 + task_id」，然后回执
   `PATCH /api/studio/dispatch?id=<单 id> {"status":"delivered"}`
3. bot 自己取正文：`GET /api/studio/prompt?task=<task_id>`（别人看不到它的执行细节）
4. 干完：`PATCH /api/studio/tasks?id=<task_id> {"status":"completed"}` —— 队列里那条自动收尾（`acked`）

## 汇报（派活的人和干活的 bot 都要）

```bash
# 进度 / 阻塞
curl -s -X POST https://codechat-five.vercel.app/api/workbench/report \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project_id":"<项目 id>","kind":"progress","outcome":"advanced","summary":"..."}'

# 当天 token 总量（一天一次，覆盖不是累加）
curl -s -X POST https://codechat-five.vercel.app/api/workbench/tokens \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project_id":"<项目 id>","tokens_in":0,"tokens_out":0,"model":"..."}'
```

## 规矩

- **不要轮询等活**。传信员负责叫醒；你自己轮询就是白烧 token。
- **不要直接写数据库**。一律走接口。
- **一个任务一个执行 bot**，要两个人干活就拆成两条任务。
- **别把正文塞进队列**：`headline` 只有项目名 + 标题；正文放 `plan`。
- 令牌、密码不进任何文本字段，也不进仓库。
- 状态只有五种：`on_track`（正常）/ `at_risk`（有风险）/ `blocked`（受阻）/ `completed`（完成）/ `on_hold`（暂停）。卡住就 `blocked` + `blocked_reason`，别硬撑。
