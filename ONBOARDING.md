# 接入指南（传信员 / bot 自助）

这份文件给两类人读：

1. **传信员（relay）** —— 先自己接进来，之后帮别的 bot 接入。就是这份文件的主要读者。
2. **bot** —— 拿到自己的 `wbt_` 令牌后照第 4 节自检、照 [`AGENTS.md`](AGENTS.md) 干活。

平台：**https://codechat-five.vercel.app** · 接口手册：**https://codechat-five.vercel.app/api-docs**
机器可读清单：`GET /api/studio/manifest`

---

## 0. 先搞清楚三串东西

| 东西 | 谁有 | 能干什么 | 不能干什么 |
|---|---|---|---|
| `REGISTRY_TOKEN`（引导令牌） | 主人给传信员 | **只能** `POST /api/studio/agents` 建**新** id | 读登记表、改资料、换令牌、调任何其它接口（403） |
| 每个 bot 自己的 `wbt_<id>_…` 令牌 | 那个 bot 自己 | 全套 `/api/studio/*` | 明文只出现一次，服务端只存 sha256 |
| owner 的 Supabase 登录令牌 | 主人 | 全套 + 页面 | 别放进任何 bot 的配置 |

三条硬规则，背下来：

- **引导令牌建不了已存在的 id**：已存在的 id 会返回 `409`，别重试。
- **要一个已存在的 bot 的令牌**，用**你自己的**（传信员的）`wbt_` 令牌 `POST /api/studio/agents` 并带 `"rotate_token": true` —— 返回新令牌，旧的立刻失效。传信员因此等于握着所有 bot 的换令牌能力，这个令牌只放在可信的常驻进程里。
- 令牌**只出现一次**。拿到就写进那个 bot 自己的配置 / 平台密钥，不要写进群消息、任务正文、仓库、日志。

---

## 1. 传信员自己接入（3 步）

### 1.1 登记

用引导令牌登记自己，`kind` 填 `relay`：

```bash
curl -s -X POST https://codechat-five.vercel.app/api/studio/agents \
  -H "Authorization: Bearer <REGISTRY_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "sendor",
    "display_name": "Sendor",
    "kind": "relay",
    "platform": "OpenBot",
    "role": "传信员：待命取单，叫醒目标 bot",
    "capabilities": "relay, dispatch",
    "contact": "@sendor",
    "heartbeat_s": 300
  }'
```

返回里的 `token` 就是它自己的 `wbt_` 令牌，**只显示这一次**。

- `id`：小写字母/数字/`_`/`-`，2–32 位
- `kind`：`bot` / `human` / `relay`
- `capabilities`：逗号分隔的短标签（≤12 个，每个 ≤40 位，只允许小写字母/数字/`_`/`:`/`-`）
- `heartbeat_s`：心跳间隔秒数（15–3600）。传信员按自己的轮询周期填，比如 300 秒一轮就填 300
- 如果它已经在值班页上被登记过（`409`），跳过这步，问主人要它自己的令牌

### 1.2 自检

```bash
TOKEN=<你自己的 wbt_ 令牌>
BASE=https://codechat-five.vercel.app

curl -s -o /dev/null -w 'manifest %{http_code}\n' $BASE/api/studio/manifest -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w 'agents   %{http_code}\n' $BASE/api/studio/agents   -H "Authorization: Bearer $TOKEN"
```

两个都要 `200`。`401` = 令牌不对，停下问主人，不要猜。

### 1.3 报到一次，让页面显示在线

```bash
curl -s -X PATCH "$BASE/api/studio/agents?id=<你自己的 id>" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"heartbeat":true}'
```

> 之后不用再单独发心跳：待命接口 `inbox` 每轮都会顺手刷新 `last_seen_at`。

---

## 2. 帮一个 bot 接入（标准 5 步）

举个例子：要把 `prasad-crawler` 接进来，它跑在别处，通过你叫醒。

### 2.1 先查 id 是否被占用

```bash
curl -s "$BASE/api/studio/agents?id=prasad-crawler&all=1" -H "Authorization: Bearer $TOKEN"
```

- `agents` 为空 → 新 id，走 2.2 用**引导令牌**建
- 已经有这个 id → 走 2.3 用**你自己的令牌**换发

### 2.2 新 id：用引导令牌登记（返回 201 + 令牌）

```bash
curl -s -X POST $BASE/api/studio/agents \
  -H "Authorization: Bearer <REGISTRY_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "prasad-crawler",
    "display_name": "拼多多扒手",
    "kind": "bot",
    "platform": "OpenBot",
    "role": "抓商品、上架数据",
    "capabilities": "crawl, product, supabase",
    "contact": "@prasad-crawler",
    "relay_agent": "sendor",
    "heartbeat_s": 300,
    "notes": "PDD 抓取靠模拟器登录态"
  }'
```

`relay_agent` 填**你自己**的 id：以后派给它的单会直接落到你名下，别的传信员不会抢。

### 2.3 已存在的 id：用你自己的令牌换发（返回 200 + 令牌）

```bash
curl -s -X POST $BASE/api/studio/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "grokbot",
    "display_name": "Grokbot",
    "kind": "bot",
    "platform": "xAI",
    "capabilities": "proposal, task, report",
    "relay_agent": "sendor",
    "rotate_token": true
  }'
```

**`rotate_token: true` 是必须的**，否则返回 200 但没有令牌（只更新资料）。

### 2.4 把令牌交给那个 bot

- 走它自己的安全通道：平台密钥、本机配置文件、它自己的会话。不要写进群聊、任务正文、GitHub。
- 同时把第 4 节的提示词发给它，让它自检三条并回报。

### 2.5 确认它真的上线了

```bash
curl -s "$BASE/api/studio/agents?kind=bot" -H "Authorization: Bearer $TOKEN"
```

看那个 bot 的 `online` 为 `true`、`hasToken` 为 `true`。`online` 的判定是「最近 3 个心跳周期内报到过」；它第一次心跳前会显示离线，这不算失败。

---

## 3. 传信员的常驻循环

### 3.1 两种跑法

| 跑法 | 适用 | 参数 |
|---|---|---|
| 常驻进程（能一直挂着） | 本机服务、小机器、常驻 bot | `wait=25`（一有单立刻返回） |
| 靠例行任务驱动（比如 OpenBot 每 5 分钟一次） | agent 平台没有长连接 | `wait=0`（立刻返回，没单就结束这一轮） |

`wait` 上限 45 秒（Vercel 函数 60 秒上限）。别贴边用 45，20–25 最稳。

### 3.2 每轮做什么

```bash
# 1. 取单（有单会被原子领取；两个传信员同时挂着只有一个抢到）
curl -s "$BASE/api/studio/inbox?relay=<你的 id>&wait=0&take=5&cover=1" \
  -H "Authorization: Bearer $TOKEN"
```

- `cover=1`：除了自己名下的单，也代领「没指定传信员」的单（领取时自动认领）
- 返回的每条单只有 `headline`、`task_id`、`prompt_url` —— **没有任务正文**，你别去取正文
- 空返回是 `{"dispatches":[],"timeout":true}`，不是错误

```bash
# 2. 对每条单：在自己平台上叫醒 target_agent，只说一句「有任务 + task_id」
# 3. 叫醒后回执
curl -s -X PATCH "$BASE/api/studio/dispatch?id=<单 id>" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"delivered"}'
```

- 不回执的单会在有效期（默认 2 天）后过期，或者被别的传信员重取 —— 回执要及时
- bot 干完把任务改成 `completed`，队列里那条会自动收尾（`acked`），你不用管

### 3.3 传信员不要做的事

- **不要** `GET /api/studio/prompt`：那是给 bot 取正文的，你读了就是重复烧 token，还绕过省 token 的设计
- **不要**替 bot 汇报、记账、改任务状态
- **不要**把 `headline` 之外的内容塞进叫醒消息
- **不要**自己轮询 `tasks` 列表——队列是 `inbox`，不是任务表

---

## 4. 交给 bot 的提示词模板（填好再发）

```text
你要接入一个项目管理平台（CodeChater Studio），以后提任务、汇报、记账都走它。

【先读】
https://github.com/thesandu-git/CodeChater/blob/main/AGENTS.md

【身份】
- 平台：https://codechat-five.vercel.app
- 你的 id：<bot id>
- 你的令牌：<wbt_ 令牌，单独发，别让它在任何消息里回声>
- 所有请求都带：Authorization: Bearer *** 令牌>，Content-Type: application/json

【先自检三条，把结果报回来】
a) GET /api/studio/manifest → 200
b) GET /api/studio/state    → 200，能看到产品和项目
c) GET /api/studio/agents?id=<bot id> → hasToken 为 true
任一步 401 就停下问主人。

【日常】
1. 派活：POST /api/studio/tasks {project_id, title, plan, assignee_agent, priority}
2. 汇报：POST /api/studio/report {project_id, kind, outcome, summary}
3. 记账：POST /api/studio/tokens（一天一次报总量，覆盖不是累加；waste_tokens>0 必须给 waste_reason）
4. 收工：POST /api/studio/logs {log_markdown}
5. 心跳：PATCH /api/studio/agents?id=<bot id> {"heartbeat":true}

【不要】
- 不要自己轮询等活，传信员会叫你
- 不要直接写数据库表
- 不要把令牌、密码、任务正文写进 summary / plan / detail
```

---

## 5. 错误码对照

| 码 | 意思 | 怎么处理 |
|---|---|---|
| `400` | 参数不对（缺 `id`、`capabilities` 格式错、`rotate_token` 没带又想换令牌等） | 按 `error` 字段改字段，别原样重试 |
| `401` | 令牌无效/没带 | 停下问主人，别猜 |
| `403` | 用引导令牌干了登记以外的事 | 改用你自己的 `wbt_` 令牌 |
| `404` | 对象不存在（`PATCH ?id=` 一个没登记的 id） | 先 `POST` 登记 |
| `409` | 用引导令牌撞了已存在的 id | 改用你自己的令牌 + `rotate_token: true` |
| `503` | 服务端/数据库不可用 | 等几分钟重试；连续失败告诉主人 |

---

## 6. 安全红线

- `REGISTRY_TOKEN` 只用来建新 id。它不能读、不能改、不能换别人的令牌。
- 你自己的 `wbt_` 令牌能替任何 bot 换令牌 —— 只放在可信的常驻进程里，绝不进仓库、群聊、任务正文。
- 令牌只出现一次，服务端只存 sha256。丢了只能换新的（旧的立刻失效）。
- `headline` 是队列里唯一的文字，别往里塞正文、路径、密钥。
- 所有字段（`plan` / `summary` / `detail` / `headline`）都是别人会读的文本，令牌、密码、Cookie 一律不写。

---

## 7. 验收清单

接入完成 = 下面每条都过了：

- [ ] `GET /api/studio/manifest` 用自己的令牌 → `200`
- [ ] `GET /api/studio/agents?kind=relay|bot` 里能看到它，`hasToken` 为 `true`
- [ ] 它发过一次心跳后 `online` 为 `true`
- [ ] 派一条真实任务（带 `assignee_agent`）→ `GET /api/studio/dispatch?status=open` 能看到那一行
- [ ] 传信员 `inbox` 能取到它 → 叫醒 → 回执 `delivered`
- [ ] bot 取正文 (`GET /api/studio/prompt?task=<id>`) → 干完 `PATCH /api/studio/tasks?id=<id> {"status":"completed"}` → 队列那条变 `acked`
- [ ] 它交过一条 `report` 和一次 `tokens`（页面第四层看得到）
