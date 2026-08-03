# 项目工作空间 W1+W2 设计（M1 落地版）

- **撰写日期**：2026-05-18
- **作者**：Product Planning（AI 协作）
- **范围**：以普通租户用户登录后"很多功能不可用"为契机，按 `2026-05-13-platform-evolution-design.md` §2.3 **M1 项目工作空间** 落地真正可用的 `/workspace/[projectId]/*`，并把现有 `/dashboard/*` 严格拆分到「项目维度（workspace）」与「平台维度（platform）」两个空间
- **关联文档**：
  - 母 spec：`docs/superpowers/specs/2026-05-13-platform-evolution-design.md`
  - 现有 W1 草稿 plan：`docs/superpowers/plans/2026-05-13-m1-project-workspace.md`（本 spec **扩写并替代**它的设计部分）
- **状态**：Draft，待用户评审

---

## 0. 问题陈述

当前所有用户登录后都被丢进 `/dashboard/*`——这套 UI 本质是**超管控制台**。普通租户用户（`user_tenants.role ∈ {owner,admin,member,viewer}`，**非** `is_superadmin`）登录后：

1. 仪表盘卡片里的"数据库连接 0 / 数据表 0"是平台维度的事实（普通用户根本看不到），不是项目维度的实际数据
2. 侧边栏摆着 SQL 查询 / 平台监控 / 全租户管理等只属超管的入口
3. 任何挂载组件（如右上角"健康检查"按钮、`/dashboard/monitor` 里的 `circuit-breakers` 卡）一调用 `require_superadmin_middleware` 保护的接口，axios 全局拦截器无差别 toast 出红色 "**该接口仅平台超级管理员可访问**"

根本原因不是"少了几个 if"，而是**架构错位**：本应有两套并列的工作空间——
- `/platform/*`：平台/超管控制台（已存在，需吸收散落在 `/dashboard/` 的超管独占页）
- `/workspace/[projectId]/*`：项目工作空间（**当前完全不存在**，是本次要建的）

母 spec 早已规划了 M1，但没动；并且把 W1 (壳) 和 W2 (页面迁移) 合在一起讲，本 spec 把它进一步拆开。

---

## 1. 范围与不做

### 1.1 W1 范围（先做）

- 新建 `/workspace/[projectId]/*` 路由层、layout、侧边栏、项目首页
- 登录后路由分发：超管 → `/platform`；项目成员 → `/workspace/[projectId]`（多项目走选择页）
- `/workspace` 项目选择页（用户隶属多项目时使用）
- `axios` 拦截器对 401/403 改为智能处理
- 服务端：复用现有 `tenant_handlers` + 现有 RBAC；**不新增中间件**（W1 完全靠现有 `auth_middleware + dynamic_db_middleware + rbac` 链路）
- **现有 `/dashboard/*` 暂保留**但 layout 加引导跳转——W1 上线即用户体验改善

### 1.2 W2 范围（紧接 W1）

- 把现有 `/dashboard/*` 下**真正属于项目维度**的页面物理迁移到 `/workspace/[projectId]/*`
- 把现有 `/dashboard/*` 下**超管独占**的页面物理迁移到 `/platform/*`
- 删除 `/dashboard/*`；新增 `/dashboard/[...slug]/page.tsx` 全局重定向兜底，过渡期 ≥ 1 个版本
- 各迁移后页面：取 `projectId` 从 URL（而不是 Zustand）；按 `user_tenants.role` 隐藏写入按钮（但**不替代后端 RBAC**）

### 1.3 不做（明确边界）

- **可视化建表 ER 编辑器**（M3，归 W3）
- **RBAC 可视化矩阵 / 行级条件构建器**（M4，归 W4）
- **AI 助手 NL2SQL / 慢查询诊断**（M7，归 W5）
- **新建项目向导**（M2，独立项目）—— W1 阶段项目仍由超管 SQL/API 手工创建
- **后端 `permissions` 表的项目级默认数据 seed 脚本** —— W2 阶段写一个 idempotent migration 顺手补，但完整 RBAC 模板留给 W4

---

## 2. 系统架构

### 2.1 三个空间的边界

```
┌──────────────────────────────────────────────────────────────────┐
│                          /login                                  │
│      ┌────────────┬───────────────┬───────────────────────┐      │
│      ▼            ▼               ▼                       ▼      │
│ is_superadmin   仅 1 个项目     多个项目              无项目     │
│      │            │               │                       │      │
│      ▼            ▼               ▼                       ▼      │
│ /platform   /workspace/[id]  /workspace（选择页）  /workspace/no-projects
└──────────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   /platform/*            /workspace/[projectId]/*
   ─────────────────      ─────────────────────────
   平台超管视图：          项目工作空间：
   • 租户/项目管理         • 概览
   • 用户管理              • 数据库（表/索引/函数/触发器）
   • 全平台连接池          • API & RPC
   • 系统监控/熔断/限流    • 安全（角色/RLS/ACL/API Key）
   • SQL 查询/事务         • 事件（Webhook/定时任务）
   • 审计日志              • 监控（项目维度）
                          • 设置（成员管理，仅 owner/admin 可见）
```

### 2.2 URL 形态

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `/login` | 登录 | 公开 |
| `/workspace` | 项目选择页（用户有 2+ 项目时） | 已登录任意用户 |
| `/workspace/no-projects` | 无项目用户引导页 | 已登录任意用户 |
| `/workspace/[projectId]` | 项目首页（数据概览） | 该项目成员 / 超管 |
| `/workspace/[projectId]/database/...` | 表 / 函数 / 触发器 / 索引 | 该项目成员 / 超管 |
| `/workspace/[projectId]/api` | API 文档 + 调用器 | 该项目成员 / 超管 |
| `/workspace/[projectId]/rpc` | RPC 调用器 | 该项目成员 / 超管 |
| `/workspace/[projectId]/security/...` | RLS / Roles / RPC-ACL / API Key | 该项目 admin+ / 超管 |
| `/workspace/[projectId]/events/...` | Webhook / 定时任务 | 该项目 admin+ / 超管 |
| `/workspace/[projectId]/monitor` | 项目维度查询性能 / 慢查询 / 审计 | 该项目成员 / 超管 |
| `/workspace/[projectId]/settings/...` | 项目设置 / 成员 | 该项目 owner+ / 超管 |
| `/platform/*` | 已存在，吸收 `/dashboard/query` 等超管页 | 仅 `is_superadmin` |
| `/dashboard/*` → 重定向 | W2 删除后保留 `[...slug]` 兜底 | 重定向到 `/workspace/[currentId]` 或 `/platform` |

**为什么用 `projectId` 数字而不是 `slug`？**

现有 W1 plan 草稿用 `[projectSlug]`，理由是更易读；但本 spec 改用 `projectId`（即 `management.tenants.id`），理由：

1. 现有 `tenants` 表 `slug` 列可为 NULL（约束在 schema 里不是 NOT NULL）；老数据无 slug
2. 现有所有 dynamic_db 链路都用 `database_id` (= tenant.id) 做 pool key，**URL 里直接拿到 id** = 后端无需再做一次 slug→id 查询
3. RPC 路由刚刚才统一到 `/api/v1/{database_id}/rpc/{fn_name}` 用 id；workspace 用 id 保持一致

副作用：URL 出现 `/workspace/42/database/tables` 这种数字 id 看起来不友好。**缓解**：项目顶栏始终展示 `项目名称 + slug`；用户大部分时间从仪表盘点导航，URL 不暴露给非技术用户。如果未来真要支持 slug，可加一条 `/workspace/by-slug/[slug] → 302 → /workspace/[id]/...` 的辅助路径。

### 2.3 与现有 W1 草稿 plan 的差异

| 主题 | 现有 W1 plan | 本 spec |
|---|---|---|
| URL 标识符 | `[projectSlug]` | `[projectId]`（理由见 §2.2） |
| Header 透传 | `X-Project-Slug` | **不引入新 header**——所有项目级请求直接走 URL path 或现有 `X-Database-Id`，工作空间只是前端壳 |
| 后端中间件 | 新增 `project_context_middleware` | **不新增**——现有 `dynamic_db_middleware + auth + rbac` 三层够用 |
| 项目首页内容 | 6 个 "M3/M4/M5/M6/M7 占位" 卡片 | 数据概览（项目信息 + 4 指标卡片 + 最近活动 + 快捷入口） |
| /dashboard 行为 | 非超管 + 有 slug 就跳；其他保持 | W1 阶段同左；W2 阶段全局 [...slug] 重定向后删除 |
| 页面迁移 | 不在 plan 内（仅占位） | W2 显式覆盖（见 §4） |

**结论**：现有 W1 plan 实质是"占位壳"；本 spec 把它精简为更小的 W1（不引入 `X-Project-Slug` / 不引入 `project_middleware`），同时新增 W2 覆盖真实页面迁移。

---

## 3. W1 详细设计

### 3.1 后端改动（轻量）

**新增的端点**（在 `auth_middleware` 链路内）：

```
GET  /api/projects              # 列出当前用户可见项目（is_superadmin 看全部，普通用户走 user_tenants join）
GET  /api/projects/:id          # 单项目详情（含 workspace_config / 用户在此项目的 role）
```

**实现要点**：
- 直接查 `management.tenants` + `management.user_tenants`，**不引入新 model 文件**——`tenants.kind` / `workspace_config` 两列在 plan 草稿的 Task 1 已规划，本 spec 沿用
- `GET /api/projects/:id` 返回字段中**新增 `user_role`**，由 `user_tenants.role` 取出（超管返回 `'superadmin'`）；前端用这个字段做能力门槛
- `PATCH /api/projects/:id/config` 推迟到 W4 RBAC 完整模板落地时再做（W1+W2 不需要）

**不需要的东西**：
- ❌ `X-Project-Slug` 请求头注入
- ❌ `project_context_middleware` 中间件
- ❌ `project_models.rs` / `project_handlers.rs` 独立模块（直接加到 `tenant_handlers.rs` 里两个函数即可）

### 3.2 前端改动

#### 3.2.1 `app/workspace/page.tsx`（项目选择页）

行为：
1. 从 `/api/projects` 拉当前用户可见项目列表
2. **`projects.length === 1` 时直接 `router.replace('/workspace/${projects[0].id}')`**
3. `projects.length === 0` 时 `router.replace('/workspace/no-projects')`
4. 其他情况展示项目卡片列表（项目名 / slug / 用户角色 badge / "进入" 按钮）
5. 顶部带"切换项目"语义，避免用户混淆

#### 3.2.2 `app/workspace/no-projects/page.tsx`

简单引导页：
- 大字"您当前没有可访问的项目"
- 副标题"请联系平台管理员为您分配项目"
- 如果用户碰巧是超管，加一个"前往 /platform 管理项目"按钮（边角情况但要友好）
- 底部"退出登录"按钮

#### 3.2.3 `app/workspace/[projectId]/layout.tsx`

职责：
1. **token 守卫**：无 token → `/login`
2. **加载项目元数据**：`api.get(/api/projects/${projectId}, { suppressErrorToast: true })`
3. **失败兜底**：
   - 404 → 友好页面"项目不存在或你无权访问"，引导回 `/workspace`
   - 403 → 同上（普通用户访问非自己项目）
   - 其他错误 → 错误页 + "重试"按钮
4. **写本地状态**：成功后把 `{ id, name, slug, user_role }` 存进 Zustand `currentProject`；**不存 localStorage**（避免与 `currentTenant` 串扰）
5. **渲染壳**：顶部 ProjectTopbar + 左侧 WorkspaceSidebar + 右侧 main

`projectId` 始终从 `useParams<{ projectId: string }>()` 拿，**严禁从 Zustand 拿**——保证 URL 是 source of truth。

#### 3.2.4 `components/workspace/ProjectTopbar.tsx`

```
┌──────────────────────────────────────────────────────────────┐
│ [Logo]  shrxhub_test  ▾   │ 概览  数据库  API  …  │  user ▾  │
│         (slug: shrxhub_test, owner)                          │
└──────────────────────────────────────────────────────────────┘
```

- 左侧"项目切换器"下拉：再调一次 `/api/projects`，点其他项目 → `router.push('/workspace/${otherId}')`；如果用户只有 1 个项目，不显示下拉箭头
- 右侧 user 菜单：原有"用户信息 / 退出"；超管多一条"前往 `/platform`"

#### 3.2.5 角色层级与能力映射

本 spec 使用的"角色层级"约定（高 → 低）：

```
superadmin (平台超管) > owner > admin > member > viewer
```

"admin+" 表示 `role ∈ {admin, owner, superadmin}`；"member+" 表示 `role ∈ {member, admin, owner, superadmin}`；以此类推。这只是**前端 UI 能力门槛**的速记，**后端 RBAC 校验是真值来源**，本 spec 不依赖角色名做后端鉴权。

#### 3.2.6 `components/workspace/WorkspaceSidebar.tsx`

按 IA "by object" 7 个分组（带每组实际链接清单——后续 W2 会逐步把 href 从 `#` 换成真页面）：

```
📊 概览              /workspace/[id]
🗄️ 数据库            └ 表 (/database/tables)
                    ├ 关系图 (/database/visualizer)
                    ├ 函数 (/database/functions)
                    └ 触发器 (/database/triggers)
🌐 API & RPC        ├ REST API (/api)
                    └ RPC 调用器 (/rpc)
🔒 安全              ├ 角色 (/security/roles)
                    ├ RLS (/security/rls)
                    ├ RPC ACL (/security/rpc-acl)
                    └ API Key (/security/api-keys)
🔔 事件              ├ Webhook (/events/webhooks)
                    └ 定时任务 (/events/scheduled-tasks)
📈 监控              /monitor
⚙️ 设置              ├ 项目信息 (/settings)
                    └ 成员管理 (/settings/members)
```

按能力门槛过滤（与 §4.1 表格保持一致）：
- 整组"安全"仅 `admin+` 可见
- 整组"事件"仅 `admin+` 可见
- "设置 / 成员管理"仅 `owner+` 可见
- 其余分组（概览 / 数据库 / API & RPC / 监控）对所有成员（含 viewer）可见，但**写入按钮**在子页面内按 `member+` 控制

复用 `lib/permissions.ts` 现有的 `useUiCapabilities()` 但**扩展**：新增 `deriveWorkspaceCapabilities(role)` 函数（不修改现有 `deriveUiCapabilities` 以避免影响超管控制台行为）。

#### 3.2.7 `app/workspace/[projectId]/page.tsx`（项目首页）

数据概览风格：

```
┌──────────────────────────────────────────────────────────────┐
│  shrxhub_test                                       [设置]   │
│  PG 实例: aliyun-rds-prod    Schema: public                  │
│  你的角色: owner                                              │
├──────────┬──────────┬──────────┬──────────────────────────────┤
│ 数据表    │ API 端点  │ RPC 函数 │  本月调用量                  │
│  12      │  36      │  8       │   12.3k                     │
└──────────┴──────────┴──────────┴──────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  最近活动（最近 7 天，来自 audit_logs）                       │
│  ├ 表 users 新增 3 列                14:23                   │
│  ├ RPC create_order 调用 234 次       昨天                   │
│  └ Webhook order.created 失败 2 次    2 天前                  │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  快捷入口                                                     │
│  [+ 建表]  [+ 调用 RPC]  [+ 配 Webhook]  [→ 查看 API 文档]    │
└──────────────────────────────────────────────────────────────┘
```

数据源：
- 4 个指标卡：复用现有 `schemaAPI.listTables` / `apiAPI.listEndpoints` / 函数列表 / `monitor_handlers` 的本月聚合
- 最近活动：`audit_handlers` 的 `GET /api/audit?tenant_id=...&limit=10`
- 快捷入口：纯前端 link

**W1 阶段允许把 "本月调用量" / "最近活动" 实现为 stub**（显示 "—" 或 "暂无数据"），W2 接入真实数据；不阻塞 W1 上线。

#### 3.2.8 `app/dashboard/layout.tsx` 改动

W1 阶段最小化改动——只加引导：

```typescript
// 顺序：
// 1. 无 token → /login
// 2. 超管 → /platform（保持现有行为）
// 3. 非超管：
//    - 先拉 /api/projects（前端缓存 5 分钟）
//    - 1 个项目 → /workspace/[id]
//    - 多个项目 → /workspace
//    - 0 个项目 → /workspace/no-projects
```

W1 上线后 `/dashboard/*` 实际**已无人访问**（所有用户在 layout 这一关就被分发走了），但页面文件仍保留，等 W2 物理迁移完成再统一删除。

### 3.3 401/403 智能 toast 策略

修改 `frontend-nextjs/lib/api.ts` 的响应拦截器：

```typescript
// 伪代码
if (status === 401) {
  // 不论是否 suppressErrorToast，统一跳登录页
  // 不弹 toast（避免离开页面前还闪一下红条）
  clearAuth()
  router.push('/login')
  return Promise.reject(error)
}

if (status === 403) {
  // 默认静默，不弹 toast
  // 写一条 console.warn 方便排查
  // 调用方需要展示"无权限"占位时，自己 catch 并渲染
  return Promise.reject(error)
}

// 其他状态码保持现状（4xx/5xx 仍走全局 toast）
```

调用方约定：
- 列表 / 详情类 GET 请求：catch 403 后渲染"你没有权限查看此内容"占位组件
- 写入类 POST/PATCH/DELETE：catch 403 后**手动 toast** "无权限执行此操作"（因为是用户主动行为，需明确反馈）

新增 `components/shared/ForbiddenPlaceholder.tsx` 通用占位组件，避免每页重写。

---

## 4. W2 详细设计

### 4.1 页面迁移映射表

| 现 `/dashboard/*` | 迁移到 | 角色门槛（UI） | 备注 |
|---|---|---|---|
| `/dashboard` | `/workspace/[id]`（首页） | 任意成员 | 替换为数据概览首页 |
| `/dashboard/api` | `/workspace/[id]/api` | 任意成员 | API 文档 |
| `/dashboard/visualizer` | `/workspace/[id]/database/visualizer` | 任意成员 | 关系图 |
| `/dashboard/tables` | `/workspace/[id]/database/tables` | 任意成员（写需 member+） | 表管理 |
| `/dashboard/functions` | `/workspace/[id]/database/functions` | 任意成员（写需 member+） | 函数管理 |
| `/dashboard/rls` | `/workspace/[id]/security/rls` | admin+ | 行级安全 |
| `/dashboard/roles` | `/workspace/[id]/security/roles` | admin+ | 角色管理 |
| `/dashboard/rpc-acl` | `/workspace/[id]/security/rpc-acl` | admin+ | RPC ACL |
| `/dashboard/rpc` | `/workspace/[id]/rpc` | 任意成员 | RPC 调用器 |
| `/dashboard/webhooks` | `/workspace/[id]/events/webhooks` | admin+ | Webhook |
| `/dashboard/scheduled-tasks` | `/workspace/[id]/events/scheduled-tasks` | admin+ | 定时任务 |
| `/dashboard/monitor` | **拆分**：项目卡片去 `/workspace/[id]/monitor`，平台卡片去 `/platform/monitor` | 项目维度任意成员；平台维度仅超管 | 现页面同时包含两类卡 |
| `/dashboard/es` | `/workspace/[id]/database/es`（如保留） | 任意成员 | 仅在 ES 是项目级时迁；否则去 `/platform` |
| `/dashboard/query` | **`/platform/sql-runner`** | 仅超管 | SQL 任意执行 |
| `/dashboard/transaction` | **`/platform/transaction`** | 仅超管 | 多语句事务 |
| `/dashboard/connections` | **`/platform/connections`** | 仅超管 | PG 池管理 |

### 4.2 迁移方式（物理迁移 + 重定向）

**步骤模板**（每个页面）：

1. **复制文件**：`app/dashboard/foo/page.tsx` → `app/workspace/[projectId]/foo/page.tsx`
2. **改 projectId 来源**：把 `const { currentTenant } = useAppStore()` 换成 `const { projectId } = useParams<{projectId:string}>(); const databaseId = parseInt(projectId)`
3. **删除原文件**
4. **能力门槛**：用 `useCurrentProject()` 拿 `user_role`；超出权限的按钮 disable + tooltip "你的角色 (member) 没有此权限"
5. **403 兜底**：所有数据请求加 `{ suppressErrorToast: true }`，外层用 `useQuery`/SWR 的 error 状态渲染 `<ForbiddenPlaceholder />`

**全局重定向兜底**：

新增 `app/dashboard/[...slug]/page.tsx`：

```typescript
// 伪代码
export default function DashboardRedirect() {
  const router = useRouter()
  const params = useParams<{ slug: string[] }>()
  useEffect(() => {
    const path = params.slug?.join('/') ?? ''
    // 查 redirectMap，把老路径映射到新路径
    const newPath = mapOldDashboardPath(path, currentProjectId)
    router.replace(newPath ?? '/workspace')
  }, [])
  return <div>正在跳转...</div>
}
```

`redirectMap` 是 §4.1 表格的代码化，保留 ≥ 1 个版本后再删除整个 `/dashboard/*` 目录。

### 4.3 平台超管页迁移到 `/platform/*`

`/platform/*` 已存在，只需在其 layout 内的 sidebar 加 3 个条目：

```
PlatformSidebar (扩展)：
- 租户与项目 → /platform/tenants
- 用户管理 → /platform/users
- PG 连接池 → /platform/connections     ← 新（来自 /dashboard/connections）
- 系统监控 → /platform/monitor          ← 新（来自 /dashboard/monitor 平台卡片）
- SQL 查询 → /platform/sql-runner       ← 新（来自 /dashboard/query）
- 事务管理 → /platform/transaction      ← 新（来自 /dashboard/transaction）
- 限流规则 → /platform/rate-limits      ← 现有
- 审计日志 → /platform/audit            ← 现有
```

迁移本身和 §4.2 步骤一致，只是目标目录是 `/platform/*`。

---

## 5. 数据流

### 5.1 登录到首屏完整流程

```
用户提交登录表单
   │
   ▼
POST /auth/login → 拿到 token + user (含 is_superadmin)
   │
   ▼
setAuthToken / setCurrentUser
   │
   ▼
if is_superadmin: router.push('/platform')
else:
   GET /api/projects (suppressErrorToast)
   │
   ▼
   length === 0 → /workspace/no-projects
   length === 1 → /workspace/{projects[0].id}
   length >= 2 → /workspace（选择页）
```

### 5.2 进入项目后

```
路由 /workspace/[id]/...
   │
   ▼
layout.tsx 加载：
   1. 检查 token
   2. GET /api/projects/:id → setCurrentProject({id, name, slug, user_role})
   3. 渲染壳 + children
   │
   ▼
子页面：
   - 从 useParams 拿 projectId
   - 用 projectId 构造数据请求（如 /api/v1/{projectId}/schemas）
   - 403 → 渲染 ForbiddenPlaceholder
```

### 5.3 项目切换

```
用户在 ProjectTopbar 下拉选另一个项目
   │
   ▼
router.push('/workspace/{otherId}')
   │
   ▼
layout.tsx 重新执行 useEffect → 重新 GET /api/projects/:id
   │
   ▼
currentProject 更新；子页面 useParams 自动拿到新 id
```

---

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| Token 过期（401） | 拦截器静默清 token + `router.push('/login')`，**不 toast** |
| 用户被踢出项目（layout 拉 `/api/projects/:id` 403） | 友好错误页"你不再有权访问此项目" + "返回 `/workspace`" 按钮 |
| 项目被删除（404） | 友好错误页"项目不存在" + "返回 `/workspace`" 按钮 |
| 子页面数据请求 403 | 渲染 `<ForbiddenPlaceholder reason="你的角色 ({user_role}) 无权查看此内容" />` |
| 子页面写操作 403 | 调用方 catch 后**手动** `notify.error('权限不足')` |
| `/workspace/[id]` 不是合法数字 | layout 检测后 `router.replace('/workspace')` |
| 老 `/dashboard/foo` 直链 | `[...slug]` 兜底重定向到 `/workspace/{currentId}/foo` 或 `/platform/foo`（按 redirectMap） |
| 用户没有项目且点了项目页直链 | layout 检测项目列表为空 → `/workspace/no-projects` |

---

## 7. 测试策略

### 7.1 自动化（沿用现有 shell 测试约定）

新增 `tests/m1_workspace_test.sh`：
- Test 1：超管 GET /api/projects → 返回所有 project
- Test 2：普通用户 GET /api/projects → 只返回自己加入的
- Test 3：普通用户 GET /api/projects/{他人项目id} → 403
- Test 4：普通用户 GET /api/projects/{自己项目id} → 200 + 含 user_role 字段

前端 e2e：留给 W2 阶段补 Playwright（W1 阶段以手工 smoke 为主，参考下表）

### 7.2 手工 smoke 清单（W1 出口前必走）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 超管登录 | 进入 `/platform`，无回归 |
| 2 | `test@example.com` 登录（1 项目） | 直接进 `/workspace/{shrxhub_test_id}`，无任何红色 toast |
| 3 | 在 workspace 顶栏切项目（多项目用户） | URL 切换，layout 重新加载，子页面无残留状态 |
| 4 | 访问他人项目直链 `/workspace/{others_id}` | 友好 403 页面，"返回 `/workspace`" 可点 |
| 5 | viewer 角色用户进入项目 | 侧边栏不见"安全 / 事件 / 设置"组 |
| 6 | 在 `/workspace/[id]/database/tables` 点"新建表"（viewer 角色） | 按钮 disable + tooltip 提示，不发请求 |
| 7 | 老 `/dashboard/tables` 直链 | 重定向到 `/workspace/{currentId}/database/tables`（W2 阶段） |
| 8 | 删除 / 移除测试用户的项目权限后刷新页面 | 自动跳转到 `/workspace/no-projects` |

---

## 8. 实施顺序与依赖

### 8.1 W1 任务清单（草稿，详细 plan 单独写）

1. 后端：`tenants.kind` + `workspace_config` 列 migration（**沿用现有 W1 plan Task 1 即可**）
2. 后端：`tenant_handlers` 加 `list_projects` / `get_project` 两个 handler（**简化版**，不新增模块）
3. 前端：`lib/api.ts` 401/403 智能拦截器
4. 前端：`/workspace/page.tsx` 项目选择页
5. 前端：`/workspace/no-projects/page.tsx`
6. 前端：`/workspace/[projectId]/layout.tsx`
7. 前端：`components/workspace/ProjectTopbar.tsx`
8. 前端：`components/workspace/WorkspaceSidebar.tsx`
9. 前端：`/workspace/[projectId]/page.tsx` 项目首页（指标可 stub）
10. 前端：`components/shared/ForbiddenPlaceholder.tsx`
11. 前端：`lib/store.ts` 增 `currentProject` state；`lib/permissions.ts` 扩展 `useUiCapabilities` 接受 `user_role`
12. 前端：`/dashboard/layout.tsx` 加普通用户引导跳转
13. 测试：`tests/m1_workspace_test.sh`
14. 手工 smoke：§7.2 全过

**预期 1.5-2 周**（1 后端 0.5 周 + 1 前端 1.5 周，可并行）。

### 8.2 W2 任务清单（草稿）

按 §4.1 表格，每页 0.5-1 天迁移（共 ~15 页）：

- 先迁项目维度（11 页）→ 跑 smoke
- 再迁超管页到 /platform（4 页）→ 跑 smoke
- 加 `/dashboard/[...slug]` 兜底重定向
- 端到端回归 + Playwright 补关键路径

**预期 2-3 周**。

### 8.3 W3/W4/W5 由独立 spec 启动

不在本 spec 范围内，但 W2 收尾时应：
- 把"快捷入口建表"链接到一个**临时简化建表页**（不带 ER），等 W3 上线后再替换
- 在 RBAC 页面加 banner "完整可视化矩阵将在 W4 上线"

---

## 9. 风险与开放问题

### 9.1 已识别风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 现有 `tenants` 表用户场景里没区分"是 project 还是 legacy"，导致老用户也被路由到 workspace | 中 | W1 阶段 `/api/projects` 接口**直接返回所有用户加入的 tenants 不过滤 kind**；kind 字段仅用于未来 M2 自助开通时打标 |
| `currentTenant`（旧 Zustand）和 `currentProject`（新）并存导致状态污染 | 中 | layout 进入时强制 `setCurrentTenant(null)`；旧 dashboard 页面迁完后整段删除 Zustand 的 currentTenant |
| 顶栏项目切换器会 N+1 拉 `/api/projects`（每次点开下拉） | 低 | SWR / 5 分钟缓存 |
| 普通用户在 layout 阶段拉项目列表慢 → 首屏白屏 | 低 | layout 显示骨架屏；接口 timeout 兜底 |
| 老书签 `/dashboard/foo` 在 W1 阶段没重定向就 404 | 低 | W1 阶段保留老 `/dashboard/*` 不删（layout 改成引导跳转后基本无人访问）；W2 才删 |
| `lib/permissions.ts` 当前的 `deriveUiCapabilities` 只看 `is_superadmin`；扩展后可能影响现有 dashboard 行为 | 中 | 加新函数 `deriveWorkspaceCapabilities(role)` 而不是改老的；老 dashboard 暂不动 |

### 9.2 开放问题（实施前需确认）

- [ ] **`management.tenants.id` 是否所有项目都已经存在合法值？** 需要扫一遍是否有 NULL/0 等异常值
- [ ] **现存 `user_tenants.role` 数据分布**：实际有多少用户是 `viewer` / `member` / `admin` / `owner`？是否需要给某些用户预先升级角色才能让他们用得起 workspace？
- [ ] **是否需要顶栏环境标记**（prod / staging）？母 spec 未提；倾向不做
- [ ] **项目首页"本月调用量"数据源**：`monitor_handlers` 是否已经按 tenant_id 聚合？需要 Sample 一下 API 看返回格式
- [ ] **是否要 i18n 准备**：母 spec §2.4 写"v1 仅中文"——本 spec 沿用，硬编码中文字串

---

## 10. 验收标准

W1 完成等价于：

1. ✅ `test@example.com` 登录后**直接进入** `/workspace/{shrxhub_test_id}`，**0 条红色 toast**
2. ✅ workspace 首页能看到项目名、自己的角色、4 个指标卡片（即使值是 "—"）
3. ✅ 侧边栏 7 个分组按角色正确过滤；点不到的功能不勾引
4. ✅ 超管登录进入 `/platform` 无回归
5. ✅ `tests/m1_workspace_test.sh` 全绿
6. ✅ `tests/integration_test.sh` 无回归
7. ✅ 手工 smoke §7.2 全过

W2 完成等价于：

1. ✅ §4.1 所有页面迁移完成；老 `/dashboard/*` 物理删除
2. ✅ `/dashboard/[...slug]` 重定向兜底覆盖所有老路径
3. ✅ `/platform/*` 侧边栏吸收 SQL / 事务 / 连接池 / 系统监控
4. ✅ 普通用户**完全无法**访问任何会触发 `require_superadmin` 的入口（菜单层屏蔽 + URL 直链时 layout 兜底）
5. ✅ Playwright 关键路径自动化覆盖（登录 → workspace → 切项目 → 建表 → 调 RPC → 看监控）

---

## 11. 后续行动

1. **本 spec 用户评审** → 改动 / 通过
2. **撰写 W1 plan**（基于本 spec §8.1，替换 `2026-05-13-m1-project-workspace.md` 的部分内容）
3. **W1 实施**（1.5-2 周）
4. **W1 出口验收** → 立即用 `test@example.com` 复测最初的问题
5. **撰写 W2 plan** → W2 实施（2-3 周）
6. W2 完成后启动 W3 (M3) / W4 (M4) / W5 (M7) 三个独立 spec

---

*本 spec 是 `docs/superpowers/specs/2026-05-13-platform-evolution-design.md` §2.3 M1 的具体落地设计。它 supersedes `docs/superpowers/plans/2026-05-13-m1-project-workspace.md` 中关于"设计"的部分（任务编排部分仍可作为 W1 plan 起点）。*
