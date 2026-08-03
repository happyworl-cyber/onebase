# W3 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / superpowers:executing-plans

**Goal:** 收尾 W2 推迟的 4 件事；让 `/dashboard/*` 真正彻底退役。

**收口标志：** `frontend-nextjs/app/dashboard/` 里只剩 `[...slug]/page.tsx` + `page.tsx` + `layout.tsx`，0 个功能性子目录。

**Tech stack：** 同 W1/W2（Next.js 14 App Router / Zustand / TailwindCSS / 后端不动）

---

## 任务清单（按依赖先后）

### Task 1 —— 4 个"残留 dashboard"页面归位

W2 Task 10 当时认为 query / query-analyzer / slow-queries / transaction 是平台级，要迁去 `/platform/*`。但仔细看代码：

| 页面 | 真实数据源 | 真实分类 |
|---|---|---|
| `query` | `queryAPI.execute` → `/query`（X-Database-Id）| **项目级**（在某个项目 db 上跑 SQL）|
| `transaction` | `transactionAPI.*` → `/transaction/*`（X-Database-Id）| **项目级** |
| `query-analyzer` | `queryPerfAPI` → `/api/query-perf/*`（X-Database-Id）| **项目级**（读项目 db 的 pg_stat_statements）|
| `slow-queries` | 3 tab 混合：pg_stats / live 是 X-Database-Id，app tab 是 `/api/admin/slow-queries`（平台）| **项目级（含平台 tab）**，与 monitor 同形 |

修正分类：4 个都归 `/workspace/[projectId]/database/*`。W2 plan 里 "真正 platform 只 2 个" 的说法不对——`query`/`transaction` 都在 tenant db 上跑 SQL，URL 必须带项目 id。

**实施：**
- [ ] 1.1 `query` → `/workspace/[projectId]/database/query`：cp + 加 `useParams` 取 projectId（如有需要给 API 用）+ 加 `canManageProjectSettings` 门槛（任意 SQL 风险高）
- [ ] 1.2 `transaction` → `/workspace/[projectId]/database/transaction`：同上
- [ ] 1.3 `query-analyzer` → `/workspace/[projectId]/database/query-analyzer`：cp + 删掉 `currentTenant` 依赖（保留 useEffect 的 hash trigger 但用 projectId 替代）
- [ ] 1.4 `slow-queries` → `/workspace/[projectId]/database/slow-queries`：cp + 同上；app tab 的 403 走静默拦截器（与 monitor 同处理）
- [ ] 1.5 删 `/dashboard/{query,query-analyzer,slow-queries,transaction}`
- [ ] 1.6 `/dashboard/[...slug]/page.tsx`：把这 4 个路径加进 `DASHBOARD_TO_WORKSPACE`，从 `PLATFORM_ONLY_LEGACY` 移除
- [ ] 1.7 sidebar 加这 4 条入口到 "数据库" 组下面（or 单独 "诊断/调试" 子组），按角色门槛过滤

### Task 2 —— `/api` 拆出 `/security/api-keys`

> W2 commit `1957ed5` 已经把单页迁到 `/workspace/[id]/api`；现在做拆分。

`/dashboard/api/page.tsx`（已搬到 workspace）有 3 个 tab：`overview` / `keys` / `docs`。`keys` tab 是写操作（创建 / 删除 / 改权限），与 `overview`+`docs`（只读）心智分离。

**实施：**
- [ ] 2.1 抽出 `app/workspace/[projectId]/api/page.tsx` 中的 keys-tab JSX 到新文件 `app/workspace/[projectId]/security/api-keys/page.tsx`
- [ ] 2.2 原 `/api` 页保留 overview + docs tab；删 `keys` tab 选项；加跳转链接到 `/security/api-keys`
- [ ] 2.3 sidebar 在 "安全" 组下加回 `API Key` 条目（之前 W2 cleanup commit 暂时去掉了）
- [ ] 2.4 角色门槛：`canManageSecurity`（admin+），与 RPC ACL / Roles 一致

### Task 3 —— `/monitor` 拆出 `/platform/monitor`

> 当前 workspace 下的 monitor 页面 6 个 endpoint 混在一起（W2 commit `1fa04fc`）；非超管的 admin/* 调用会被静默 403。

**实施：**
- [ ] 3.1 在 `app/platform/monitor/page.tsx` 新建一页，只调 `/api/admin/slow-queries` + `/api/admin/circuit-breakers`
- [ ] 3.2 `app/workspace/[projectId]/monitor/page.tsx` 删掉对 `/api/admin/*` 的两条调用；UI 上去掉对应 tab/卡片
- [ ] 3.3 `PlatformSidebar` 加 `监控` 条目
- [ ] 3.4 头部注释更新

### Task 4 —— `/settings/{project-info,members}` stub 页面

**前置：** 依赖 PASE Stage E 后端（成员管理 / 项目元信息编辑 API）。

**实施（待 PASE E 落地后）：**
- [ ] 4.1 `app/workspace/[projectId]/settings/page.tsx` 项目信息编辑表单
- [ ] 4.2 `app/workspace/[projectId]/settings/members/page.tsx` 成员管理
- [ ] 4.3 sidebar 加回这两条
- [ ] 4.4 角色门槛 `canManageProjectSettings`（owner+）

**当前状态：** 不阻塞 Task 1-3。Task 4 单独跟踪。

---

## 验证

- 每个 Task 完成后跑 `tsc --noEmit`，确认无新增 error
- 用 `curl http://127.0.0.1:3006/workspace/1/database/<新页>` 验证路由 200
- `git status frontend-nextjs/app/dashboard/`：Task 1 完成后该目录里应只剩 `[...slug]/`, `page.tsx`, `layout.tsx`

## 预估

| Task | 工作量 |
|---|---|
| 1 (4 页迁移 + catch-all + sidebar) | 1-1.5 day |
| 2 (api 拆 keys-tab) | 0.5 day |
| 3 (monitor 拆) | 0.5 day |
| 4 (settings stub) | gated by PASE E |

总计 Task 1-3：~2-2.5 days。

---

## 实施记录

| Task | 状态 | 主要 commits | 备注 |
|---|---|---|---|
| 1 | **DONE** | `c1d53ff` plan / `a05c915` 4 页迁移 + catch-all + sidebar | `/dashboard/*` 现在 0 个功能子目录；catch-all 把 4 个新路径加进了 `DASHBOARD_TO_WORKSPACE`，旧 bookmark 自动 307 |
| 2 | **DONE** | `6daf758` /security/api-keys + 精简 /api | api 页 1108 → 650 行；security/api-keys 自带 `canManageSecurity` 门禁；sidebar 加回了 API Key 条目 |
| 3 | **DONE** | `a75661e` /platform/monitor + 精简 workspace/monitor | workspace/monitor 6 → 4 个 API（不再静默 403）；platform/monitor 自带阈值/条数控件；PlatformSidebar 加 "平台监控" |
| 4 | **DONE** | W4 / PASE Stage E：`87442bd` plan / `63d4a1e` 后端 / `4f79ad8` 前端 | 项目级成员管理 + 项目元信息编辑落地。/workspace/[id]/settings + /settings/members 上线 |

### 收尾后的拓扑

```
/dashboard/
  ├── [...slug]/page.tsx     // catch-all → /workspace/[currentProject]/<mapped>
  ├── layout.tsx             // 仅超管降级保护（不会有功能页命中）
  └── page.tsx               // root → /platform 或 /workspace

/workspace/[projectId]/
  ├── database/              // 表/索引/触发器/函数/扩展/关系图/导入/备份
  │                          // + 诊断：query / transaction / query-analyzer / slow-queries
  ├── security/              // roles / rls / rpc-acl / api-keys
  ├── events/                // webhooks / scheduled-tasks / es-connections
  ├── settings/connections   // 数据库连接（其他 settings 子页待 Stage E）
  ├── api/                   // 项目 REST API 概览 + 接口文档
  ├── monitor/               // 项目内 pg_stat_* 监控（4 个端点）
  ├── rpc/
  └── page.tsx               // 项目首页概览

/platform/
  ├── (项目管理 / 用户 / 审计 / SSO / 定时任务)
  └── monitor/               // 跨租户应用慢查询 + 熔断器状态
```

### 开放问题（不再阻塞 W3 收尾）

- **Task 4 settings stubs**：✅ 已在 W4 / PASE Stage E plan 中落地，见 `docs/superpowers/plans/2026-05-19-w4-pase-stage-e.md`。
- **api-keys 跳转回流**：从 `/security/api-keys` 创建完 key 后是否要给"前往 API 文档"的跳转？当前没加，新 key 只显示 hash + 复制按钮，足够。后续如有 UX 需求再补 Link。
- **monitor 自动刷新**：workspace 和 platform 两边的 `autoRefresh` 是独立的 5s 计时器，没考虑节流。当前 `Promise.allSettled` 已经保护，但同一用户在两边都开 auto 时会产生 2 套定时器。属于次要 UX，不阻塞。

*本 plan 收口 W2 plan §"有意推迟到 W3" 列出的 Task 1-3，纠正 W2 Task 10 的分类失误。Task 4 留待 PASE Stage E。*
