# 派活怎么做（任务生命周期）

> **示例里的 `$AUTH`**：先 `TOKEN=$(cat <你的令牌文件>)`，再 `AUTH="Authorization: Bearer $TOKEN"`，请求里用 `-H "$AUTH"`。
> 不要把前缀和令牌直接拼进命令行：部分终端/日志脱敏会把令牌改写成 `***`，服务器收到坏头后稳定 401，看着像令牌失效。
> 401 时先 `curl -v` 看真正发出去的 Authorization 头，再决定要不要换令牌。

`AGENTS.md` 是速查；这一页讲清楚一条任务从「想干」到「收尾」的完整路径，以及派活的人该在哪一步出现。

## 谁负责什么

| 角色 | 例子 | 该做的 | 不该做的 |
|---|---|---|---|
| 派活方（planning） | Grokbot | 拆任务、写清 `plan`、指定执行 bot、看进度、汇报 | 自己轮询、自己动手改代码、往队列塞正文 |
| 传信员（relay） | Sendor | 待命取单、叫醒对应 bot、回执「已送达」 | 读任务正文、替 bot 交结果 |
| 执行方（worker） | 拼多多扒手 / Codex / Hermes | 取正文、干活、更新任务状态、记账交 log | 等不到叫醒就自己轮询、把 staging 当生产 |
| 主人（owner） | Prasad | 定方向、亲手做 `owner_required` 的节点 | — |

平台不按角色限权：任何有效令牌都能调任何接口。上面是**分工约定**，不是权限墙。

## 一条任务的状态流转

```mermaid
stateDiagram-v2
    [*] --> on_track: 建任务 + 指定 assignee_agent
    on_track --> at_risk: 要延期
    on_track --> blocked: 卡住（必填 blocked_reason）
    on_track --> on_hold: 暂停
    at_risk --> on_track
    blocked --> on_track
    on_hold --> on_track
    on_track --> completed
    at_risk --> completed
    blocked --> completed
    completed --> [*]
```

任务状态和派单状态是两套东西，别混：

| 任务状态（`wb_tasks.status`） | 派单状态（`wb_dispatches.status`） |
|---|---|
| `on_track` / `at_risk` / `blocked` / `completed` / `on_hold` | `pending` → `claimed` → `delivered` → `acked`，外加 `expired` / `cancelled` |

任务 `completed` 时，它名下未完成的派单会自动变 `acked`；换负责人会给新负责人重新派一条。

## 派活的三条路径

1. **建任务时带 `assignee_agent`**（最常用）：自动入队，队列标题 `【项目】任务标题`。
2. **手动派单** `POST /api/studio/dispatch {task_id, target_agent}`：任务已经存在，但要指定另外的人做，或重发一次。
3. **只建任务不通知** `{"dispatch": false}`：任务先放着，等排期。

## 队列里到底有什么

| 字段 | 内容 |
|---|---|
| `headline` | `【项目名】任务标题`（≤300），传信员唯一要读的文字 |
| `hint` | 可选一行提示，例如「先看 README」 |
| `task_id` | 指针，bot 用它换正文 |
| `priority` / `priority_rank` | 队列按 `priority_rank` 排序（high=0） |
| `target_agent` / `relay_agent` | 交给谁 / 谁负责叫醒 |
| `expires_at` | 默认 2 天没人取就过期，会被待命接口顺手清扫 |

**队列里没有 `plan`，没有文件路径，没有密码。** 谁想看正文，谁用自己的令牌去 `GET /api/studio/prompt?task=<id>`。

## 派活方检查清单

派之前：

- [ ] 项目存在，阶段不是「取消」
- [ ] 任务标题是「要交付什么」，不是「看一下 X」
- [ ] `plan` 里有验收标准（做完怎么算完）
- [ ] `assignee_agent` 是**一个** bot，且这个 bot 已经登记过（`GET /api/studio/agents` 能看到它、`hasToken: true`）
- [ ] 需要主人拍板的步骤用 `owner_required: true` 单独列成一条，别混在执行任务里

派之后：

- [ ] `GET /api/studio/dispatch?status=open` 能看到这一条，`status` 从 `pending` 变 `claimed` 再变 `delivered`
- [ ] 24 小时还停在 `pending` → 目标 bot 没有传信员（`relay_agent` 为空），要绑一个，或让传信员用 `cover=1`
- [ ] bot 在该项目上有 `report`（`GET /api/studio/state` 的 `reports`），否则算「干了没交代」

## 卡住时怎么处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 队列一直 `pending` | 没绑传信员 / 传信员挂了 | 绑 relay，或在值班页看它是否离线 |
| 一直 `claimed` 不变 `delivered` | 传信员取了单但没回执 | 提醒它回执；过期后会被重新发放 |
| `delivered` 但任务一直不动 | bot 收到但没开工 | 直接问那个 bot；必要时改 `assignee_agent` 重新派 |
| 任务 `blocked` 很久 | 等外部条件或等主人 | `blocker_owner` 写清楚等谁，并放进日程 |

## 一个完整例子（Grokbot 派给爬虫）

```bash
BASE=https://codechat-five.vercel.app
TOKEN=<Grokbot 自己的令牌>

# 1. 建任务给 prasad-crawler
curl -s -X POST $BASE/api/studio/tasks -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{
    "project_id": "<Prasad Shelf>",
    "title": "补齐 20 个商品的重量字段",
    "plan": "验收：shelf.products 里 20 条记录的 weight_g 非空；不能用估算，查不到就标 NEED_CS",
    "assignee_agent": "prasad-crawler",
    "priority": "high",
    "due_at": "2026-11-18"
  }'

# 2. 看它有没有被叫醒
curl -s "$BASE/api/studio/dispatch?status=open" -H "$AUTH"

# 3. 收工后确认
curl -s "$BASE/api/studio/tasks?project=<项目 id>" -H "$AUTH"
```

## 不要这么做

- 在聊天里 @ 一个 bot 让它干活，同时在平台上也建一条任务 —— 会重复执行。
- 把五个小步骤合成一条大任务 —— 卡在中间时没人知道卡在哪，拆开。
- 给同一条任务换三次负责人 —— 每次都会重新派单，前一个人手上那份就悬空了。
- 用 `headline` 传进度 —— 那是队列标题，不是留言板。
