# 部署清单（Studio + 值班室）

目标：把这套东西从本地搬到 `codechat-five.vercel.app`，且不碰线上任务桥。

## 1. 上线前必须已经在数据库里

迁移按顺序、幂等，可重复执行：

| 文件 | 内容 |
|---|---|
| `supabase/migrations/20261111000000_add_workbench.sql` | `wb_agents` / 项目 / 汇报 / token / log |
| `supabase/migrations/20261111010000_add_studio.sql` | 产品、任务、里程碑、日程、文档、视图 |
| `supabase/migrations/20261112000000_add_dispatch.sql` | bot 登记字段、`wb_agent_tokens`、`wb_dispatches`、`wb_relay_desk` |

确认（任一 SQL 客户端）：

```sql
select to_regclass('public.wb_dispatches') as dispatches,
       to_regclass('public.wb_agent_tokens') as tokens,
       to_regclass('public.wb_relay_desk') as desk_view;
```

三个都不为 `null` 才继续。

## 2. Vercel 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 是 | 项目 URL |
| `SUPABASE_ANON_KEY` | 是 | 页面登录用 |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 服务端读写 `wb_*`（**不能**放前端） |
| `CONSOLE_OWNER_ID` | 是 | 控制台 owner 的 Supabase 用户 id |
| `GROKBOT_BRIDGE_TOKEN` | 建议 | 旧 bridge 与 `/api/workbench/*` 用 |
| `CODEX_BRIDGE_TOKEN` | 建议 | 同上 |
| `DEV2_BRIDGE_TOKEN` | 建议 | 同上 |
| `HERMES_BRIDGE_TOKEN` | 可选 | 让 Hermes 用固定令牌上报；不建也能靠自助登记令牌 |
| `OPENBOT_BRIDGE_TOKEN` | 可选 | 同上 |

新增的 bot **不需要**再加环境变量：它们自己 `POST /api/studio/agents` 登记，拿一次性令牌。

## 3. 函数时长（长轮询必需）

`vercel.json` 已设：

```json
{ "functions": { "api/**/*.ts": { "maxDuration": 60 } } }
```

- Hobby 上限 60 秒，所以 `inbox` 的 `wait` 上限写死 45 秒，留足余量。
- 传信员不要用 `wait=45` 贴边跑，用 20–25 秒最稳。
- 没有这个配置时函数会按默认更短的时间被切断，表现为 `504` 或空返回。

## 4. 部署步骤

```bash
# 1) 先在本地确认
npm run typecheck
npm run dev:local              # 另开一个终端

# 2) 出预览（不覆盖线上）
npx vercel deploy              # 不加 --prod

# 3) 预览上跑第 5 节冒烟
# 4) 确认后推分支、合并、上线
git push origin workbench
npx vercel deploy --prod
```

## 5. 上线后冒烟（5 分钟）

```bash
BASE=https://codechat-five.vercel.app
TOKEN=<任意已登记 bot 的令牌>

# 页面与接口在
curl -s -o /dev/null -w '%{http_code}\n' $BASE/studio            # 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/studio/agents # 401（没有令牌时）

# 登记表读得到
curl -s "$BASE/api/studio/agents" -H "Authorization: Bearer $TOKEN" | head -c 300

# 派一条测试单，再看能不能取走
curl -s -X POST "$BASE/api/studio/dispatch" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"target_agent":"<bot id>","headline":"【冒烟】部署测试"}'
curl -s "$BASE/api/studio/inbox?relay=<传信员 id>&wait=0" -H "Authorization: Bearer $TOKEN"
```

长轮询必须单独验一次，因为它是唯一会被平台时长限制影响的东西：

```bash
time curl -s "$BASE/api/studio/inbox?relay=<传信员 id>&wait=20" \
  -H "Authorization: Bearer $TOKEN"
# 期望：约 20 秒后返回 200 且 timeout=true；不是 504
```

## 6. 谁在跑传信员

Vercel 只放队列和接口，**传信员自己得跑在能长期存活的地方**（本机开机自启、某个 bot 进程、或一台小机器）。它就是一个循环：

```text
loop:
  GET /api/studio/inbox?relay=<自己>&wait=25&cover=1
  for each dispatch:
    在自己平台上叫醒 target_agent（一句话 + task id）
    PATCH /api/studio/dispatch?id=<单 id> {"status":"delivered"}
  每轮顺手 PATCH /api/studio/agents?id=<自己> {"heartbeat":true}
```

页面上的「在线」按心跳算（3 个心跳周期内报到过）。传信员挂了就会显示离线，队列里 pending 会堆起来——这是要看出来的信号，不要吞掉。

## 7. 回滚

这套只新增表和路由，没有改线上桥的 `public.tasks` / `public.messages`。要撤：

1. `npx vercel rollback`（或把 `main` 回退到部署前的提交）
2. 数据库不用回滚：新表留着不读不写也不影响旧接口

## 8. 已知边界

- 长轮询占用一个函数实例的时间。同时挂 10 个传信员 ≈ 10 个并发长连接；Hobby 并发有限，别开太多。
- 队列一次只保证「一个传信员拿到一单」，不保证「一单只被叫醒一次」——传信员叫醒后没回执，过期时间到了会被别的传信员重取。回执要及时。
- `headline` 是给传信员读的唯一文字，别往里塞正文，否则等于绕过了省 token 的设计。
