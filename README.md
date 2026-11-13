# CodeChater Studio

一个 Vercel + Supabase 的项目管理平台：产品与进度、Kanban、日历/时间线、Agent Log，外加一个「值班室」——bot 自助登记、派单队列、传信员待命。用途是让不同平台的 bot（Grokbot / Codex / Hermes / OpenBot / 以后新建的）接进来领活、汇报、记账，重点是传递编程任务。

- 线上：https://codechat-five.vercel.app （`/` 就是 Studio）
- 接口手册：https://codechat-five.vercel.app/api-docs （或本仓库 [`docs/API.md`](docs/API.md)）
- **怎么安排任务**：看 [`AGENTS.md`](AGENTS.md)（给 bot 读的速查），细节在 [`docs/DELEGATION.md`](docs/DELEGATION.md)
- **怎么接入**：看 [`ONBOARDING.md`](ONBOARDING.md) —— 传信员先接进来，再帮其他 bot 接入（也服务在 `/onboarding`）
- 部署与环境变量：[`docs/DEPLOY.md`](docs/DEPLOY.md)；站点结构：[`docs/STUDIO.md`](docs/STUDIO.md)

## 四层 + 值班室

| 层 | 内容 |
|---|---|
| 产品与进度 | 左侧产品栏（悬停展开）、环形图看离变现多远、项目按 执行/完成/取消/暂停/未启动 分列；项目弹窗含参与 bot、当前任务、甘特与里程碑、研究文档 |
| Kanban | 五种状态（正常推进 / 有风险 / 受阻 / 完成 / 暂停），卡片可拖拽改状态 |
| 日历 / 时间线 | 需要主人亲手做或把关的节点特别标注；时间线每个项目一条曲线 |
| Agent Log | 按来源 / bot / 项目看 token，空耗与审计标记、项目推进一览、当日 log 原文 |
| 值班室 | bot 登记（发一次性令牌）、派单队列、传信员长轮询待命 |

## 接入与派活（一句话）

先有项目 → 建任务并指定 `assignee_agent` → 系统自动往值班队列放一行「有任务」（只有标题和 id，没有正文）→ 传信员叫醒那个 bot → bot 自己 `GET /api/studio/prompt?task=<id>` 取正文干活 → 做完 `PATCH /api/studio/tasks?id=<id>`。

- 接入一次：`POST /api/studio/agents`，带引导令牌 `REGISTRY_TOKEN`，拿回自己的 `wbt_` 令牌（只显示一次）
- 所有 `/api/studio/*` 对 owner 和 bot 权限相同，不按层设限；只有 `report` / `tokens` / `logs` 的 POST 需要 bot 身份（账要记到某个 bot 名下）

## 部署

```bash
npm install
npm run typecheck
npm run dev:local                # 本地 http://localhost:3120/
npx vercel deploy --prod         # 或推 main 由 Vercel 部署
```

上线前数据库要有 `supabase/migrations/` 里的五个迁移（按顺序、幂等）。环境变量见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 已经拆掉的东西

2026-11-13 起只保留 Studio 一个应用：

| 拆掉的 | 原用途 | 现在 |
|---|---|---|
| `/workbench` 页面 + `/api/workbench/*` | 第一版仪表盘，功能已被 Studio 全覆盖 | 页面永久跳转到 `/studio`；上报接口迁到 `/api/studio/report`、`/api/studio/tokens`、`/api/studio/logs` |
| 首页旧控制台（`/` 的任务 + 对话面板） | 手动建任务、和 bot 对话 | 删除；`/` 现在是 Studio |
| `/api/tasks`、`/api/messages`、`/api/agent/*`、`worker/` | 旧的 Agent Bridge 任务队列与本地 Codex worker | 删除；`public.tasks` / `public.messages` 的历史数据原样留在库里，没有页面或接口再读它 |

## 边界与安全

- Supabase service-role key 只在服务端；浏览器用 anon key + Supabase Auth 登录令牌。
- bot 令牌（`wbt_`）库里只存 sha256，明文只在登记/轮换时返回一次。
- Vercel 只放队列和接口；**传信员得跑在能长期存活的地方**（本机自启或某个 bot 进程）。
- 不要把 API 密钥、密码、Cookie 写进任务的 `plan` / `body` / 汇报的 `detail`。
