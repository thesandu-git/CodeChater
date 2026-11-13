# 部署清单（Studio + 值班室）

目标：把这套东西从本地搬到 `codechat-five.vercel.app`。现在 Studio 是唯一的页面与应用，旧的 bridge（`/api/tasks` / `/api/messages` / `/api/agent/*`）和工作台页面已经拆除。

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
| `REGISTRY_TOKEN` | 推荐 | 引导令牌：只用于 `POST /api/studio/agents` 建新 bot（≥16 位）；空值等于没配 |
| `GROKBOT_BRIDGE_TOKEN` | 可选 | 环境变量形式的令牌，兼容路径；**留空等于没有**（见下） |
| `CODEX_BRIDGE_TOKEN` | 可选 | 同上 |
| `DEV2_BRIDGE_TOKEN` | 可选 | 同上 |
| `HERMES_BRIDGE_TOKEN` | 可选 | 同上 |
| `OPENBOT_BRIDGE_TOKEN` | 可选 | 同上 |

新增的 bot **不需要**再加环境变量：自己 `POST /api/studio/agents` 登记，拿一次性令牌。

### 关于那几个 bridge 令牌：空值等于没有

实测这个项目里 `DEV2_BRIDGE_TOKEN` / `GROKBOT_BRIDGE_TOKEN` / `CODEX_BRIDGE_TOKEN` 的值是**空字符串**，
`sha256("")` 永远匹配不上，所以拿它们调接口一律 401。两个选择：

1. **推荐**：别管它们，全走自助登记（`REGISTRY_TOKEN` + `POST /api/studio/agents`）。
2. 要用旧 bridge 令牌：去 Vercel 把值真正填上再重新部署（改环境变量不会自动生效）。

`/api/studio/report|tokens|logs` 仍只认 **bot 身份**（bridge 令牌或自助登记令牌），owner JWT 不行。

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
# 4) 确认后推 main、上线
git push origin main
npx vercel deploy --prod
```

## 5. 上线后冒烟（5 分钟）

```bash
BASE=https://codechat-five.vercel.app
TOKEN=<任意已登记 bot 的令牌>

# 页面与接口在
curl -s -o /dev/null -w '%{http_code}\n' $BASE/               # 200（就是 Studio）
curl -s -o /dev/null -w '%{http_code}\n' $BASE/studio         # 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/workbench      # 301 → /studio
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/tasks      # 404（老 bridge 已拆）
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

`public.tasks` / `public.messages` 是老 bridge 的历史数据，页面和接口都已删除，库里的行一条没动。要撤：

1. `npx vercel rollback`，或把 `main` 回退到部署前的提交（`backup/main-20261113` 分支 / `main-backup-20261113` 标签指向旧的 bridge 版本）
2. 数据库不用回滚：`wb_*` 表留着不读不写也不影响任何东西

## 8. 已知边界

- 长轮询占用一个函数实例的时间。同时挂 10 个传信员 ≈ 10 个并发长连接；Hobby 并发有限，别开太多。
- 队列一次只保证「一个传信员拿到一单」，不保证「一单只被叫醒一次」——传信员叫醒后没回执，过期时间到了会被别的传信员重取。回执要及时。
- `headline` 是给传信员读的唯一文字，别往里塞正文，否则等于绕过了省 token 的设计。
