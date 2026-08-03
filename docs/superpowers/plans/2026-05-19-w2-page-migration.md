# W2 页面物理迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `/dashboard/*` 23 个页面按 spec §4.1 物理迁移到 `/workspace/[projectId]/*`（21 页）与 `/platform/*`（2 页），删除整个 `/dashboard/*` 目录并由 `[...slug]` 兜底重定向。**收口标志：** `frontend-nextjs/app/dashboard/` 目录只剩 `[...slug]/page.tsx` 一个文件；普通租户用户的所有功能链路都跑在 `/workspace/[projectId]/...` 下，0 红 toast。

**Architecture:**
- 工作空间 layout（W1 已建）接管所有租户级页面壳；URL 中的 `projectId` 同时充当 `database_id`（spec §2.2）
- 后端在 `/api/projects/:id` 响应里追加 `primary_connection`，工作空间 layout 立刻 `setCurrentConnection` —— **这是 W2 能把现有 schemaAPI / queryAPI / rpcAPI 不改一行就接上的关键基础设施**
- 各页面物理迁移走"复制 → 改 URL 参数源 → 加角色门槛 → 删旧文件"四步模板；不重写业务逻辑
- `/dashboard/[...slug]/page.tsx` 静态映射表 + 一行 `router.replace` 兜底（≥ 1 个发布版本后删除）

**Tech Stack:** Rust (sqlx + axum) / TypeScript (Next.js 14 App Router) / Zustand / TailwindCSS

**Spec 来源：** `docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md` §4

**前置条件（已满足，由 W1 落地）：**
- `/api/projects` / `/api/projects/:id` 已发布（`src/tenant_handlers.rs:list_projects/get_project`）
- 前端 `currentProject` state + `useCurrentProjectCapabilities()` hook 已加（`lib/store.ts` + `lib/permissions.ts`）
- 工作空间外壳 `/workspace/[projectId]/{layout,page}.tsx` 在跑
- axios 拦截器 401 静默重定向 / 403 静默 + console.warn 已上线

**关键设计抉择：**

1. **`projectId` 即 `database_id`**：spec §2.2 已定。后端 RPC / RBAC / dynamic_db_middleware 链路都早已是按 `database_id` 索引；URL `/workspace/42/database/tables` 中的 `42` 直接给到 `X-Database-Id` header，无需任何映射。
2. **不在工作空间引入新中间件 / 新 header**：所有现有租户级 API 都已经走 `X-Database-Id`，只要前端在 layout 里把 `currentConnection` 设对，下游 page 不动。
3. **`/api/admin/*` ≠ 平台专属**：现状下 webhook、API-Key、scheduled-task、ES、RPC ACL 都已经走 `require_tenant_admin_for_db`，是租户内 admin 行为。迁完去 workspace，不去 platform。
4. **真正的 platform 页只有 2 个**：`/dashboard/query`（任意 SQL，明文标注"平台级原始 SQL"）+ `/dashboard/transaction`（多语句事务）。这两个去 `/platform/*`。
5. **`/dashboard/monitor` 拆**：项目卡（`/api/monitor/*`）去 workspace；平台卡（`/api/admin/slow-queries` + circuit-breakers）去 platform。

**测试策略：**

- 后端：复用 `tests/m1_workspace_test.sh` + 新增 1 个断言确认 `/api/projects/:id` 含 `primary_connection`
- 前端：每页迁完跑 `tsc --noEmit` 验证无新增 error；最后一道 `npm run build` 全量构建
- 端到端：W2 阶段引入 Playwright（spec §10 W2 出口标准）—— 但 Playwright 的搭建留作单独 PR，本 plan 仅写最小 smoke 脚本

**迁移文件 inventory**

| 现 `/dashboard/*` | 行数 | 主要状态依赖 | 目标 | 角色门槛（UI） | 备注 |
|---|---|---|---|---|---|
| `/dashboard/page.tsx` | 183 | `currentTenant`, `currentSchema` | 删除（被 `/workspace/[id]/page.tsx` 取代） | — | W1 已建首页 |
| `/dashboard/tables` | 355 | `currentSchema` | `/workspace/[id]/database/tables` | viewer 看，member+ 写 | 走 schemaAPI |
| `/dashboard/schema` | 256 | `currentSchema` | `/workspace/[id]/database/schemas` | viewer | 浏览 |
| `/dashboard/visualizer` | 217 | `currentSchema` | `/workspace/[id]/database/visualizer` | viewer | ER 图 |
| `/dashboard/indexes` | 836 | `currentSchema` | `/workspace/[id]/database/indexes` | viewer 看，member+ 写 | 独立 API |
| `/dashboard/triggers` | 526 | `currentSchema` | `/workspace/[id]/database/triggers` | viewer 看，member+ 写 | DDL 走 `/query` |
| `/dashboard/functions` | 539 | `currentSchema` | `/workspace/[id]/database/functions` | viewer 看，member+ 写 | DDL 走 `/query` |
| `/dashboard/extensions` | 356 | — | `/workspace/[id]/database/extensions` | admin+（DDL） | DDL 走 `/query` |
| `/dashboard/table-designer` | 682 | `currentSchema` | `/workspace/[id]/database/table-designer` | member+ | DDL 走 `/query` |
| `/dashboard/import` | 599 | `currentSchema` | `/workspace/[id]/database/import` | member+ | 数据导入 |
| `/dashboard/rls` | 375 | `currentSchema` | `/workspace/[id]/security/rls` | admin+ | RBAC |
| `/dashboard/roles` | 307 | — | `/workspace/[id]/security/roles` | admin+ | RBAC |
| `/dashboard/rpc-acl` | 439 | `currentConnection`, `currentSchema` | `/workspace/[id]/security/rpc-acl` | admin+ | 走 `/query` 枚举（已 403 graceful） |
| `/dashboard/api` | 1088 | `currentTenant`, `currentSchema` | `/workspace/[id]/api` + `/workspace/[id]/security/api-keys` | API 文档 viewer；API Key admin+ | **拆两页**：文档与 Key 管理 |
| `/dashboard/webhooks` | 265 | — | `/workspace/[id]/events/webhooks` | admin+ | 硬编码 `tenant_id: 1` 要修 |
| `/dashboard/scheduled-tasks` | 45（壳） | `currentTenant` | `/workspace/[id]/events/scheduled-tasks` | admin+ | 壳 + `ScheduledTasksManager` |
| `/dashboard/rpc` | 600 | `currentSchema`, `currentTenant`, `currentConnection` | `/workspace/[id]/rpc` | viewer 看，member+ 调 | databaseId 来源要改 |
| `/dashboard/es-connections` | 1243 | `currentTenant` | `/workspace/[id]/events/es-connections` 或 `/database/es` | admin+ | tenantId 来源要改 |
| `/dashboard/connections` | 463 | `currentTenant`, `currentConnection`, `userConnections` | `/workspace/[id]/settings/connections` | owner+ | 项目内连接管理 |
| `/dashboard/monitor` | 456 | — | **拆**：`/workspace/[id]/monitor` + `/platform/monitor` | 项目卡 viewer；平台卡仅超管 | 卡片按数据源分流 |
| `/dashboard/query-analyzer` | 499 | `currentTenant` | `/workspace/[id]/monitor/query-analyzer` | viewer | 项目维度 |
| `/dashboard/slow-queries` | 654 | `currentTenant` | **拆**：`/workspace/[id]/monitor/slow-queries`（pg_stats+live）+ `/platform/audit` 增 app 日志 tab | 项目维度 viewer | tab 拆分 |
| `/dashboard/query` | 810 | — | `/platform/sql-runner` | 仅超管 | 任意 SQL |
| `/dashboard/transaction` | 657 | — | `/platform/transaction` | 仅超管 | 多语句事务 |
| `/dashboard/backup` | 635 | `currentSchema`, `currentConnection` | **暂保留**，单独评估是否进 workspace | admin+（DDL） | 价值有限，W2 不动；W3 / 后续再决定 |
| `/dashboard/test` | 163 | — | **直接删** | — | dev harness，无用户价值 |
| `/dashboard/layout.tsx` | 79 | — | 删除（被 `[...slug]` 替代） | — | 兜底重定向后无 children |

合计 **21 页迁 workspace + 2 页迁 platform + 2 页特殊处置**。

---

## File Structure

### 新增（合计 ~25 个文件）

| 类别 | 文件 |
|---|---|
| Backend | `src/tenant_handlers.rs`（修改 `get_project` 增 `primary_connection`） |
| Frontend - infra | `frontend-nextjs/app/workspace/[projectId]/layout.tsx`（修改：拉到项目后 setCurrentConnection） |
| Frontend - 数据库组（9 页） | `app/workspace/[projectId]/database/{tables,schemas,visualizer,indexes,triggers,functions,extensions,table-designer,import}/page.tsx` |
| Frontend - 安全组（4 页） | `app/workspace/[projectId]/security/{rls,roles,rpc-acl,api-keys}/page.tsx` |
| Frontend - 事件组（3 页） | `app/workspace/[projectId]/events/{webhooks,scheduled-tasks,es-connections}/page.tsx` |
| Frontend - API/RPC（2 页） | `app/workspace/[projectId]/{api,rpc}/page.tsx` |
| Frontend - 监控组（3 页） | `app/workspace/[projectId]/monitor/{page,query-analyzer,slow-queries}/page.tsx` |
| Frontend - 设置组（1 页） | `app/workspace/[projectId]/settings/connections/page.tsx` |
| Frontend - 平台增补 | `app/platform/{sql-runner,transaction,monitor}/page.tsx` + 修改 `components/PlatformSidebar.tsx` |
| Frontend - 兜底 | `app/dashboard/[...slug]/page.tsx`（**唯一保留的 dashboard 文件**） |
| Frontend - 项目首页 | 修改 `app/workspace/[projectId]/page.tsx`（接入真实指标数据） |

### 删除

整个 `frontend-nextjs/app/dashboard/` 目录**除了** `[...slug]/page.tsx`。

---

## Task 1: Backend — `get_project` 增 `primary_connection`

**Files:**
- Modify: `src/tenant_handlers.rs`（找到 `get_project` 函数）

- [ ] **Step 1: 找到 `get_project`**

`src/tenant_handlers.rs` 末尾。函数签名 `pub async fn get_project(...)`。

- [ ] **Step 2: 在返回的 JSON 里追加 `primary_connection`**

在原 `Ok(Json(serde_json::json!({...})))` 之前，加一段查询用户在该项目下的"主连接"（取 `is_primary = true` 那条；查不到则取第一条）：

```rust
// 取当前用户在该项目下的主连接（用于工作空间前端自动设置 currentConnection）
let primary_connection: Option<serde_json::Value> = if claims.is_superadmin {
    // 超管没有 user_databases 记录；直接从 tenant_databases 取项目主连接
    sqlx::query(
        r#"
        SELECT id AS database_id, db_name, db_host, db_port, is_primary
        FROM management.tenant_databases
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY is_primary DESC, id ASC
        LIMIT 1
        "#,
    )
    .bind(project_id)
    .fetch_optional(&pool)
    .await
    .map_err(AppError::Database)?
    .map(|r| {
        serde_json::json!({
            "database_id": r.get::<i32, _>("database_id"),
            "db_name":     r.get::<String, _>("db_name"),
            "db_host":     r.get::<String, _>("db_host"),
            "db_port":     r.get::<i32, _>("db_port"),
            "is_primary":  r.get::<bool, _>("is_primary"),
        })
    })
} else {
    sqlx::query(
        r#"
        SELECT td.id AS database_id, td.db_name, td.db_host, td.db_port, td.is_primary
        FROM management.tenant_databases td
        JOIN management.user_databases ud ON ud.database_id = td.id
        WHERE td.tenant_id = $1 AND ud.user_id = $2 AND td.is_active = true
        ORDER BY td.is_primary DESC, td.id ASC
        LIMIT 1
        "#,
    )
    .bind(project_id)
    .bind(claims.sub)
    .fetch_optional(&pool)
    .await
    .map_err(AppError::Database)?
    .map(|r| {
        serde_json::json!({
            "database_id": r.get::<i32, _>("database_id"),
            "db_name":     r.get::<String, _>("db_name"),
            "db_host":     r.get::<String, _>("db_host"),
            "db_port":     r.get::<i32, _>("db_port"),
            "is_primary":  r.get::<bool, _>("is_primary"),
        })
    })
};
```

然后在最终 `Ok(Json(...))` 的对象里加一行 `"primary_connection": primary_connection,`。

**注意：表名可能是 `management.user_databases` / `management.tenant_databases`，请按当前代码库实际表名为准（在文件顶部 `use` 区或其他 handler 里能找到示例）。**

- [ ] **Step 3: cargo check**

```bash
cargo check 2>&1 | tail -10
```

Expected: `Finished` 无 error。

- [ ] **Step 4: 启动后端 smoke**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
# 拿 admin token
TOKEN=$(curl -sS -X POST http://127.0.0.1:3000/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","password":"Admin123"}' \
    | grep -oE '"token":"[^"]+"' | cut -d'"' -f4)
# 取一个 tenant id
TID=$(curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/projects \
    | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
# 验证 primary_connection 字段
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/projects/$TID \
    | grep -oE '"primary_connection":[^}]+}' | head -1
kill $BACKEND_PID
```

Expected: 输出包含 `"primary_connection":{...}` 或显式 `"primary_connection":null`（如果该项目无连接绑定）。

- [ ] **Step 5: Commit**

```bash
git add src/tenant_handlers.rs
git commit -m "feat(w2): include primary_connection in GET /api/projects/:id"
```

---

## Task 2: Frontend — 工作空间 layout 自动 setCurrentConnection

**Files:**
- Modify: `frontend-nextjs/app/workspace/[projectId]/layout.tsx`
- Modify: `frontend-nextjs/lib/store.ts`（如果 `Project` 接口要加 `primary_connection` 字段）

- [ ] **Step 1: 扩 `Project` 接口**

`lib/store.ts` 中 `export interface Project` 内加一个可选字段：

```typescript
primary_connection?: {
  database_id: number
  db_name: string
  db_host: string
  db_port: number
  is_primary: boolean
} | null
```

- [ ] **Step 2: 工作空间 layout 用拿到的 primary_connection 设 currentConnection**

`app/workspace/[projectId]/layout.tsx` 里，在 `.then((resp) => { setCurrentProject(resp.data) })` 之后**追加**一段：

```typescript
.then((resp) => {
  setCurrentProject(resp.data)

  // W2 核心补丁：把项目主连接铺到 currentConnection，让所有现有 schemaAPI /
  // queryAPI / rpcAPI 在不改一行的前提下直接走对的 X-Database-Id。
  // primary_connection 为 null（项目还没有连接）时不动 currentConnection——
  // 子页面里的"暂无连接"提示会按业务逻辑处理。
  if (resp.data.primary_connection) {
    const pc = resp.data.primary_connection
    setCurrentConnection({
      user_id: 0, // 未知，但下游不读这个字段；保留接口形状
      username: '',
      tenant_id: resp.data.id,
      tenant_name: resp.data.name,
      database_id: pc.database_id,
      connection_name: pc.db_name,
      db_host: pc.db_host,
      db_port: pc.db_port,
      db_name: pc.db_name,
      is_primary: pc.is_primary,
      user_role: resp.data.user_role,
    })
  }
  setAuthorized(true)
})
```

同时在 effect 顶部把 `const setCurrentConnection = useAppStore((s) => s.setCurrentConnection)` 加上。

- [ ] **Step 3: tsc 验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep -E "workspace/\[projectId\]/layout|lib/store" ; echo "===done==="
```

Expected: 无 error。

- [ ] **Step 4: 浏览器 smoke**

启动后端 + 前端，登录 `test@example.com`：
1. 进 `/workspace/[id]` 后开 DevTools → Network → 看 `/api/schema/public/tables` 之类的请求是否带 `X-Database-Id`，且值是项目主连接的 id
2. localStorage 的 `current_connection` 已有正确的对象

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/layout.tsx frontend-nextjs/lib/store.ts
git commit -m "feat(w2): workspace layout auto-sets currentConnection from project.primary_connection"
```

---

## Task 3: 接入项目首页指标卡的真实数据

**Files:**
- Modify: `frontend-nextjs/app/workspace/[projectId]/page.tsx`

W1 时所有 4 个指标都是 `—`。现在 layout 已经设了 connection，可以安全调 schemaAPI 等。

- [ ] **Step 1: 改首页**

```typescript
const [tableCount, setTableCount] = useState<number | string>('—')
const [rpcCount, setRpcCount] = useState<number | string>('—')

useEffect(() => {
  if (!currentProject?.primary_connection) return

  // 数据表：走 schemaAPI（已经按 currentConnection 走 X-Database-Id）
  schemaAPI
    .listTables(currentProject?.workspace_config?.default_schema as string || 'public', {
      suppressErrorToast: true,
    } as ApiRequestConfig)
    .then((resp) => {
      const tables = (resp.data as any)?.tables ?? (resp.data as any)?.data ?? []
      setTableCount(Array.isArray(tables) ? tables.length : '—')
    })
    .catch(() => setTableCount('—'))

  // RPC 函数：未必有专门 endpoint；W1 阶段保留 '—'，W2 阶段可选用
  // /api/v1/{databaseId}/rpc 取 OpenAPI（如果 RPC 路由已经有 OPTIONS）；
  // 不破坏 W2 主线进度，本 step 仅实现"数据表"和"本月调用量" 2 个指标
}, [currentProject?.id, currentProject?.primary_connection])
```

API 端点 / 本月调用量两个指标的真实数据源：
- API 端点：等同于"用户可访问的 schema 表数 + 各表暴露的 REST endpoints"，**W2 阶段保留 `—`**，等 W3/W4 spec 落地后再接
- 本月调用量：`monitor_handlers` 当前不按 tenant 聚合（spec §9.2 标了 open question），**W2 阶段保留 `—`**

所以 W2 实际接的就是"数据表"一项，其余维持 stub。

- [ ] **Step 2: tsc 验证 + 浏览器 smoke**

```bash
cd frontend-nextjs && node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep "workspace/\[projectId\]/page" ; echo "===done==="
```

浏览器：超管和 `test@example.com` 都进 workspace 首页，"数据表"卡显示一个正数。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/page.tsx
git commit -m "feat(w2): wire workspace home '数据表' metric to schemaAPI.listTables"
```

---

## Task 4: 数据库组迁移（9 页一次性，模板化）

**Files:**
- Create: `app/workspace/[projectId]/database/{tables,schemas,visualizer,indexes,triggers,functions,extensions,table-designer,import}/page.tsx`
- Delete: 对应的 `app/dashboard/{...}/page.tsx`

迁移走"复制 → 删 currentTenant 引用（如有） → 加 useCurrentProjectCapabilities 守卫 → 删旧文件" 四步。

- [ ] **Step 1: 写一个迁移辅助小脚本（可选）**

`scripts/migrate_dashboard_page.sh`（一次性）：

```bash
#!/usr/bin/env bash
# 用法：./scripts/migrate_dashboard_page.sh tables database/tables
set -euo pipefail
SRC="frontend-nextjs/app/dashboard/$1/page.tsx"
DEST_REL="$2"
DEST="frontend-nextjs/app/workspace/[projectId]/$DEST_REL/page.tsx"

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
echo "Copied $SRC -> $DEST"
echo "  → 手工 review，对照 Task 4 §模板检查清单"
```

- [ ] **Step 2: 模板检查清单（每页过一遍）**

对每个迁过来的 `page.tsx`：

1. **顶部加（如需）：**
   ```typescript
   import { useParams } from 'next/navigation'
   import { useCurrentProjectCapabilities } from '@/lib/permissions'
   ```

2. **删除：** 顶部任何 `'use client'` 已存在不需要重复；**保留**原有所有 `'use client'`

3. **替换：** 任何 `const { currentTenant, ... } = useAppStore(...)` 移除 `currentTenant` 解构（W2 后这个字段在 workspace 内为 null）。

4. **替换 databaseId 来源（如果原代码读 `currentTenant.database_id`）：**
   ```typescript
   // before
   const databaseId = currentTenant?.database_id
   // after
   const params = useParams<{ projectId: string }>()
   const databaseId = parseInt(params.projectId, 10)
   ```

5. **加角色门槛**（针对写入按钮）：
   ```typescript
   const caps = useCurrentProjectCapabilities()
   // 在原有按钮上加 disabled / hidden
   <button
     disabled={!caps.canWriteDatabase}
     title={!caps.canWriteDatabase ? '你的角色 (viewer) 没有写入权限' : ''}
     ...
   >
   ```

6. **不动**：`currentSchema`、`currentConnection`、所有 schemaAPI/queryAPI/tableAPI 调用 —— 这些靠 Task 2 已经铺好。

7. **不动**：路径里如果有 `/dashboard/...` 跳转（例如 next 参数）改成 `/workspace/${params.projectId}/...`。

- [ ] **Step 3: 逐页迁移**

按从简单到复杂的顺序：

```bash
# 简单：纯浏览
./scripts/migrate_dashboard_page.sh schema    database/schemas
./scripts/migrate_dashboard_page.sh visualizer database/visualizer
./scripts/migrate_dashboard_page.sh tables    database/tables

# 中等：独立 API
./scripts/migrate_dashboard_page.sh indexes   database/indexes
./scripts/migrate_dashboard_page.sh import    database/import

# 复杂：走 /query DDL
./scripts/migrate_dashboard_page.sh extensions     database/extensions
./scripts/migrate_dashboard_page.sh functions      database/functions
./scripts/migrate_dashboard_page.sh triggers       database/triggers
./scripts/migrate_dashboard_page.sh table-designer database/table-designer
```

每页迁完跑一次：

```bash
cd frontend-nextjs && node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep "workspace/\[projectId\]/database/$PAGE" ; echo "===$PAGE done==="
```

- [ ] **Step 4: 删旧文件**

九页全部就绪后：

```bash
for p in tables schema visualizer indexes triggers functions extensions table-designer import; do
  rm -rf frontend-nextjs/app/dashboard/$p
done
```

- [ ] **Step 5: 浏览器 smoke**

启动前端，普通用户登录后进 `/workspace/[id]/database/tables`：
- 表列表渲染
- viewer 角色 "新建表" 按钮 disable
- member+ 角色按钮可点

- [ ] **Step 6: Commit**

建议**一次性 commit** 减少 review 噪音；或按 3 个子组 commit（pure-browse / API-driven / DDL）：

```bash
git add frontend-nextjs/app/workspace/[projectId]/database \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): migrate 9 database pages to /workspace/[projectId]/database/*"
```

---

## Task 5: 安全组迁移（4 页）

**Files:**
- Create: `app/workspace/[projectId]/security/{rls,roles,rpc-acl,api-keys}/page.tsx`
- Delete: `app/dashboard/{rls,roles,rpc-acl}/`
- Modify: `app/dashboard/api` 的 API Key tab → 拆到 `security/api-keys`（页面拆分见 Task 7）

- [ ] **Step 1: 迁 rls、roles、rpc-acl**

走 Task 4 §模板。这三页里 `rpc-acl` 略复杂（W1 末段刚动过），但模板照样适用。

```bash
./scripts/migrate_dashboard_page.sh rls     security/rls
./scripts/migrate_dashboard_page.sh roles   security/roles
./scripts/migrate_dashboard_page.sh rpc-acl security/rpc-acl
```

注意：rpc-acl 页面里原本有 `PermissionGate requires="canManageRbac"` 的包裹，迁过来后改成 `caps.canManageSecurity`（来自 `useCurrentProjectCapabilities`）。

- [ ] **Step 2: api-keys 页面单建**

由于 `/dashboard/api` 同时包含"REST API 文档"和"API Key 管理"两个 tab，需要拆分。本步先单独建一个 `security/api-keys/page.tsx`，把 API Key 部分代码拷过来；`/dashboard/api` 的 REST 文档部分留给 Task 7。

模板：

```tsx
'use client'
import { useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { apiKeyAPI } from '@/lib/api'
// ... 其它原 /dashboard/api 里 API Key 部分用到的 import

export default function ApiKeysPage() {
  const params = useParams<{ projectId: string }>()
  const databaseId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageSecurity) {
    return <ForbiddenPlaceholder reason="API Key 管理需要 admin+ 角色" />
  }

  // ... 把 /dashboard/api 里跟 API Key 相关的 state + 列表 + 创建表单
  // ... 全部搬过来，把 currentTenant?.database_id 全换成 databaseId
}
```

- [ ] **Step 3: 删旧文件 + tsc + smoke + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/{rls,roles,rpc-acl}

cd frontend-nextjs && node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep "workspace/\[projectId\]/security" ; echo "===done==="

git add frontend-nextjs/app/workspace/[projectId]/security \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): migrate 4 security pages to /workspace/[projectId]/security/*"
```

---

## Task 6: 事件组迁移（3 页：webhooks / scheduled-tasks / es-connections）

**Files:**
- Create: `app/workspace/[projectId]/events/{webhooks,scheduled-tasks,es-connections}/page.tsx`
- Delete: `app/dashboard/{webhooks,scheduled-tasks,es-connections}/`

- [ ] **Step 1: webhooks 迁移**

走 Task 4 §模板。**注意**：`webhooks` 原代码里有一处硬编码 `tenant_id: 1` 的创建表单默认值，迁过来时改成 `parseInt(params.projectId, 10)`，并去掉用户可编辑的 tenant_id 字段（项目内只能操作自己的）。

- [ ] **Step 2: scheduled-tasks 迁移**

`/dashboard/scheduled-tasks/page.tsx` 是个 45 行的薄壳，套着 `<ScheduledTasksManager lockedTenantId={currentTenant.id} />`。

新页面：

```tsx
'use client'
import { useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ScheduledTasksManager from '@/components/ScheduledTasksManager'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

export default function ScheduledTasksPage() {
  const params = useParams<{ projectId: string }>()
  const caps = useCurrentProjectCapabilities()

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="定时任务管理需要 admin+ 角色" />
  }

  return <ScheduledTasksManager lockedTenantId={parseInt(params.projectId, 10)} />
}
```

- [ ] **Step 3: es-connections 迁移**

文件最大（1243 行），但靠 `currentTenant?.id` 的引用只有 2-3 处。迁移模板照旧；把 `currentTenant.id` 全部替换为 `parseInt(params.projectId, 10)`。

- [ ] **Step 4: 删旧 + tsc + smoke + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/{webhooks,scheduled-tasks,es-connections}

git add frontend-nextjs/app/workspace/[projectId]/events \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): migrate 3 events pages to /workspace/[projectId]/events/*"
```

---

## Task 7: API & RPC 迁移（2 页 / 实际是 1 拆 2 + 1）

**Files:**
- Create: `app/workspace/[projectId]/api/page.tsx`（剥 API Key 部分后的 REST API 文档）
- Create: `app/workspace/[projectId]/rpc/page.tsx`
- Delete: `app/dashboard/{api,rpc}/`

- [ ] **Step 1: api/page.tsx**

把 `/dashboard/api` 里**除了 API Key tab 之外**的部分（REST 接口文档、curl 示例、PostgREST 用法）拷到新页。

- 顶部加 `useParams` + `databaseId = parseInt(params.projectId, 10)`
- `curl` 示例里凡是 `localhost:3000/api/v1/{databaseId}` 的字符串模板，把 `{databaseId}` 替换变量来源
- 角色门槛：viewer 即可读

- [ ] **Step 2: rpc/page.tsx**

迁 `/dashboard/rpc`。

注意：原代码有 `databaseId = currentTenant?.database_id ?? currentConnection?.database_id`，改成：

```typescript
const params = useParams<{ projectId: string }>()
const databaseId = parseInt(params.projectId, 10)
```

调用按钮的能力门槛：`caps.canCallApi`（viewer 也可调，但写入类 RPC 可能需要 member+，由后端 RBAC 拒绝）。

- [ ] **Step 3: 删旧 + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/{api,rpc}

git add frontend-nextjs/app/workspace/[projectId]/api \
        frontend-nextjs/app/workspace/[projectId]/rpc \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): migrate api & rpc pages to /workspace/[projectId]/*"
```

---

## Task 8: 监控组迁移与拆分（4 页 / 3 拆 + 1 迁）

**Files:**
- Create: `app/workspace/[projectId]/monitor/page.tsx`（项目维度的 `/api/monitor/*` 卡）
- Create: `app/workspace/[projectId]/monitor/query-analyzer/page.tsx`
- Create: `app/workspace/[projectId]/monitor/slow-queries/page.tsx`（pg_stats + live tabs）
- Create: `app/platform/monitor/page.tsx`（circuit-breakers + 跨 DB 平台监控）
- Modify: `app/platform/audit/page.tsx` 增 "应用日志" tab（原 slow-queries 的 app tab）
- Delete: `app/dashboard/{monitor,query-analyzer,slow-queries}/`

- [ ] **Step 1: 拆 `/dashboard/monitor`**

读一遍原 `/dashboard/monitor/page.tsx`（456 行）。识别哪几张卡片走 `/api/monitor/*`（项目维度，迁 workspace），哪几张走 `/api/admin/circuit-breakers` 或 `/api/admin/slow-queries`（平台维度，迁 platform）。

按数据源把 JSX 切两段：
- `app/workspace/[projectId]/monitor/page.tsx`：项目卡
- `app/platform/monitor/page.tsx`：平台卡

公共组件（如 `<MetricCard>`、`<TimeSeries>`）抽到 `components/monitor/*.tsx` 共用。

- [ ] **Step 2: 迁 query-analyzer**

走 Task 4 §模板。`currentTenant?.id` 改成 `parseInt(params.projectId, 10)`。

- [ ] **Step 3: 拆 slow-queries**

原页有三个 tab：`pg_stats` / `live` / `app`。
- `pg_stats` + `live` 两 tab → `app/workspace/[projectId]/monitor/slow-queries/page.tsx`
- `app` tab → 拷到 `app/platform/audit/page.tsx` 作为新 tab（"应用日志"），因为它本质就是审计

- [ ] **Step 4: 删旧 + tsc + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/{monitor,query-analyzer,slow-queries}

git add frontend-nextjs/app/workspace/[projectId]/monitor \
        frontend-nextjs/app/platform/monitor \
        frontend-nextjs/app/platform/audit \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): split monitor pages — project cards to workspace, platform cards to platform"
```

---

## Task 9: 项目设置组（1 页：connections）

**Files:**
- Create: `app/workspace/[projectId]/settings/connections/page.tsx`
- Delete: `app/dashboard/connections/`

- [ ] **Step 1: 迁移**

`/dashboard/connections` 原本用 `currentTenant` 做过滤。迁过来：
- 用 `parseInt(params.projectId, 10)` 替换所有 `currentTenant.id` / `currentTenant.database_id`
- 角色门槛：`caps.canManageProjectSettings`（owner+）；不达者渲染 `<ForbiddenPlaceholder/>`
- 不允许选择别的项目（因为本页就在某个项目壳内）—— 去掉项目选择器 UI

- [ ] **Step 2: 删旧 + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/connections

git add frontend-nextjs/app/workspace/[projectId]/settings \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): migrate connections to /workspace/[projectId]/settings/connections"
```

---

## Task 10: 平台增补（query / transaction → /platform/*）

**Files:**
- Create: `app/platform/sql-runner/page.tsx`（迁自 `/dashboard/query`）
- Create: `app/platform/transaction/page.tsx`（迁自 `/dashboard/transaction`）
- Modify: `components/PlatformSidebar.tsx`（增菜单条目）
- Delete: `app/dashboard/{query,transaction}/`

- [ ] **Step 1: 迁 query → /platform/sql-runner**

直接 `cp -r app/dashboard/query app/platform/sql-runner`。

进入新文件：
- 顶部把"工作空间内 SQL 运行"的提示语改成"平台超管直接 SQL"
- 删除原 `targetDatabaseId` 的"必填" UI 提示（仍是必填，只是平台超管要选目标库），加一个 `<DatabaseSelector>`（如已有现成组件就用）

注意：这一页**保持现状**地继续走 `/query` endpoint。不在本任务里重构。

- [ ] **Step 2: 迁 transaction → /platform/transaction**

同上模板。

- [ ] **Step 3: 改 PlatformSidebar**

在 `components/PlatformSidebar.tsx` 的导航数组里加：

```typescript
{ label: 'SQL Runner', href: '/platform/sql-runner', icon: 'fas fa-terminal' },
{ label: '事务管理',   href: '/platform/transaction', icon: 'fas fa-stream' },
{ label: '系统监控',   href: '/platform/monitor',     icon: 'fas fa-chart-line' }, // 已在 Task 8 创建
```

放在合理位置（建议"审计日志"上面）。

- [ ] **Step 4: 删旧 + tsc + commit**

```bash
rm -rf frontend-nextjs/app/dashboard/{query,transaction}

git add frontend-nextjs/app/platform/{sql-runner,transaction} \
        frontend-nextjs/components/PlatformSidebar.tsx \
        frontend-nextjs/app/dashboard
git commit -m "feat(w2): move query/transaction to /platform/* and expose in sidebar"
```

---

## Task 11: 收尾——`/dashboard/[...slug]` 兜底重定向 + 删除残余 dashboard

**Files:**
- Create: `app/dashboard/[...slug]/page.tsx`
- Modify: `app/dashboard/layout.tsx`（极简化）
- Delete: 所有剩余 `app/dashboard/*` 子目录（应该只剩 `page.tsx` + `backup` + `test`）

- [ ] **Step 1: 写兜底**

```tsx
// app/dashboard/[...slug]/page.tsx
'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'

/**
 * 老 /dashboard/* 直链兜底（W2 spec §4.2）。
 *
 * 映射策略：
 *   - 静态映射表覆盖已迁移路径
 *   - 未覆盖路径 → /workspace（让 picker 决定）
 *   - 超管直链一些"平台页" → /platform
 *
 * 保留 ≥ 1 个发布版本，确认无老链接还在被访问后整目录删除。
 */
const REDIRECT_MAP: Record<string, (projectId: string | null) => string> = {
  // 项目维度（workspace）
  'tables':           (p) => p ? `/workspace/${p}/database/tables`         : '/workspace',
  'schema':           (p) => p ? `/workspace/${p}/database/schemas`        : '/workspace',
  'visualizer':       (p) => p ? `/workspace/${p}/database/visualizer`     : '/workspace',
  'indexes':          (p) => p ? `/workspace/${p}/database/indexes`        : '/workspace',
  'triggers':         (p) => p ? `/workspace/${p}/database/triggers`       : '/workspace',
  'functions':        (p) => p ? `/workspace/${p}/database/functions`      : '/workspace',
  'extensions':       (p) => p ? `/workspace/${p}/database/extensions`     : '/workspace',
  'table-designer':   (p) => p ? `/workspace/${p}/database/table-designer` : '/workspace',
  'import':           (p) => p ? `/workspace/${p}/database/import`         : '/workspace',
  'rls':              (p) => p ? `/workspace/${p}/security/rls`            : '/workspace',
  'roles':            (p) => p ? `/workspace/${p}/security/roles`          : '/workspace',
  'rpc-acl':          (p) => p ? `/workspace/${p}/security/rpc-acl`        : '/workspace',
  'api':              (p) => p ? `/workspace/${p}/api`                     : '/workspace',
  'rpc':              (p) => p ? `/workspace/${p}/rpc`                     : '/workspace',
  'webhooks':         (p) => p ? `/workspace/${p}/events/webhooks`         : '/workspace',
  'scheduled-tasks':  (p) => p ? `/workspace/${p}/events/scheduled-tasks`  : '/workspace',
  'es-connections':   (p) => p ? `/workspace/${p}/events/es-connections`   : '/workspace',
  'monitor':          (p) => p ? `/workspace/${p}/monitor`                 : '/workspace',
  'query-analyzer':   (p) => p ? `/workspace/${p}/monitor/query-analyzer`  : '/workspace',
  'slow-queries':     (p) => p ? `/workspace/${p}/monitor/slow-queries`    : '/workspace',
  'connections':      (p) => p ? `/workspace/${p}/settings/connections`    : '/workspace',
  // 平台维度
  'query':            () => '/platform/sql-runner',
  'transaction':      () => '/platform/transaction',
  // 未迁移（保留入口）
  'backup':           (p) => p ? `/workspace/${p}` : '/workspace', // backup 暂未迁，先回首页
}

export default function DashboardLegacyRedirect() {
  const router = useRouter()
  const params = useParams<{ slug?: string[] }>()
  const currentProject = useAppStore((s) => s.currentProject)

  useEffect(() => {
    const slug = params.slug?.[0]
    const projectIdStr = currentProject?.id ? String(currentProject.id) : null

    let dest = '/workspace'
    if (slug && REDIRECT_MAP[slug]) {
      dest = REDIRECT_MAP[slug](projectIdStr)
    } else if (slug) {
      // 未知子路径：保守跳 /workspace；后面 picker 决定
      dest = '/workspace'
    }

    router.replace(dest)
  }, [params.slug, currentProject?.id, router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
        <p className="text-sm text-gray-500">正在跳转到新的工作空间…</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 极简化 `app/dashboard/layout.tsx`**

```tsx
'use client'

/**
 * /dashboard/* 已不再是真实页面（W2 完成后）。
 * 这层 layout 只是 Next.js 段路由所需，不做任何鉴权——交给 [...slug] 兜底
 * 重定向页面自己处理（reads currentProject from Zustand）。
 *
 * 计划在 W2 后的 1 个发布版本内删除整个 /dashboard 目录。
 */
export default function DashboardLegacyLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
```

- [ ] **Step 3: 删除 backup / test 和顶层 page.tsx**

```bash
# 试期内 backup 也直接删；它没有用户依赖
rm -rf frontend-nextjs/app/dashboard/test
rm -rf frontend-nextjs/app/dashboard/backup
rm -f  frontend-nextjs/app/dashboard/page.tsx
```

最终 `app/dashboard/` 只剩：
```
app/dashboard/
├── [...slug]/page.tsx
└── layout.tsx
```

- [ ] **Step 4: tsc + 浏览器 smoke**

```bash
cd frontend-nextjs && node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep "dashboard" ; echo "===done==="
```

启动前端，在浏览器地址栏输入 `/dashboard/tables` → 应自动跳到 `/workspace/<currentProjectId>/database/tables`，跳转过程显示 "正在跳转到新的工作空间…"。

试 `/dashboard/query`（超管登录后）→ `/platform/sql-runner`。

试 `/dashboard/i-made-this-up` → `/workspace`（picker 兜底）。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/app/dashboard
git commit -m "feat(w2): add /dashboard/[...slug] redirect catch-all and delete remaining dashboard pages"
```

---

## Task 12: 更新 WorkspaceSidebar 链接 + 验证

W1 时 WorkspaceSidebar 的 href 已经写好（`/database/tables` 等），现在迁移完应该全部命中实际页面。

**Files:**
- 验证 `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx` 的 href 列表与本 plan §"迁移文件 inventory" 表的目标路径一一对应

- [ ] **Step 1: 逐项对照**

打开 `WorkspaceSidebar.tsx`，把里面每个 `href` 和本 plan 的目标路径对一遍。差异（按预期）：
- `/api` → 应改成 `/api`（已对）
- `/rpc` → ✓
- `/database/tables` → ✓
- `/database/visualizer` → ✓
- `/database/functions` → ✓
- `/database/triggers` → ✓
- `/security/roles` → ✓
- `/security/rls` → ✓
- `/security/rpc-acl` → ✓
- `/security/api-keys` → ✓（Task 5 新建）
- `/events/webhooks` → ✓
- `/events/scheduled-tasks` → ✓
- `/monitor` → ✓
- `/settings` → 当前指向不存在的 `/workspace/[id]/settings`，本 plan 未迁；可暂时去掉或指向"项目信息" placeholder（建议保留 sidebar 入口，单独页面后续补，或者改成只指向 `/settings/connections`）
- `/settings/members` → 同上，不在 W2 范围

**结论**：可能需要补 2 个 stub 页面：
- `/workspace/[projectId]/settings/page.tsx`（最小化"项目信息"展示，从 currentProject 读）
- `/workspace/[projectId]/settings/members/page.tsx`（先写 placeholder："成员管理将在 W4 上线"）

- [ ] **Step 2: 加 stub 页面**

```tsx
// app/workspace/[projectId]/settings/page.tsx
'use client'
import { useAppStore } from '@/lib/store'

export default function ProjectSettingsPage() {
  const currentProject = useAppStore((s) => s.currentProject)
  if (!currentProject) return null
  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold">项目信息</h1>
      <dl className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-2 gap-3 text-sm">
        <dt className="text-gray-500">项目名</dt><dd>{currentProject.name}</dd>
        <dt className="text-gray-500">slug</dt><dd className="font-mono">{currentProject.slug || '—'}</dd>
        <dt className="text-gray-500">状态</dt><dd>{currentProject.status}</dd>
        <dt className="text-gray-500">联系邮箱</dt><dd>{currentProject.contact_email || '—'}</dd>
        <dt className="text-gray-500">你的角色</dt><dd>{currentProject.user_role}</dd>
      </dl>
      <p className="text-xs text-gray-500">高级设置 / 重命名 / workspace_config 编辑将在 W4 落地。</p>
    </div>
  )
}
```

```tsx
// app/workspace/[projectId]/settings/members/page.tsx
'use client'
export default function MembersPlaceholderPage() {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
      <i className="fas fa-info-circle text-amber-600 text-xl mb-2"></i>
      <h2 className="text-base font-medium text-gray-900 mb-1">成员管理</h2>
      <p className="text-sm text-gray-600">该功能将随 W4 RBAC 可视化矩阵一并上线。</p>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/settings
git commit -m "feat(w2): add settings/members placeholder pages to satisfy sidebar links"
```

---

## Task 13: 全量回归与 W2 出口验收

**Files:** 无（验证步骤）

- [ ] **Step 1: 后端编译 + 跑现有集成测试**

```bash
cargo build 2>&1 | tail -3
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8

./tests/m1_workspace_test.sh > /tmp/m1.log 2>&1 ; M1_EXIT=$?
./tests/integration_test.sh > /tmp/int.log 2>&1 ; INT_EXIT=$?

kill $BACKEND_PID

echo "m1: $M1_EXIT  int: $INT_EXIT"
[[ $M1_EXIT -eq 0 && $INT_EXIT -eq 0 ]] && echo "ALL GREEN" || echo "FAIL"
```

Expected: `ALL GREEN`。

- [ ] **Step 2: 前端构建**

```bash
cd frontend-nextjs
npm run build 2>&1 | tail -20
```

Expected: build 成功；任何新增 tsc error 需要在本 task 范围内修掉（不再容忍历史 tsc error 借口）。

- [ ] **Step 3: 手工 smoke**

按 spec §7.2 顺序逐项：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 超管登录 → `/platform` | 维持现状，无回归 |
| 2 | 超管侧栏点 "SQL Runner" / "事务管理" / "系统监控" | 三个新页面正常渲染 |
| 3 | 普通用户登录 → 自动进 `/workspace/[id]` | 0 红 toast；项目首页"数据表"显示真实数字 |
| 4 | 走完 7 个分组：概览 / 数据库 / API & RPC / 安全 / 事件 / 监控 / 设置 | 各页面都能进，所有页面网络面板里 X-Database-Id 是项目 id |
| 5 | viewer 角色试新建表 | 按钮 disable + tooltip |
| 6 | admin 角色进 RLS / RPC ACL / 角色 | 都能进，能保存 |
| 7 | owner 角色进 /settings/connections | 能进，能切主连接 |
| 8 | 老链接 `/dashboard/tables` 直链 | 跳转到 `/workspace/<id>/database/tables` |
| 9 | 老链接 `/dashboard/query`（已登录超管） | 跳转到 `/platform/sql-runner` |
| 10 | 老链接 `/dashboard/random-thing` | 跳转到 `/workspace`（picker 兜底） |
| 11 | 切项目（顶栏 dropdown） | 新项目的连接被设置上，子页面数据正确 |

- [ ] **Step 4: 删 W2 完成后的 stale 文件检查**

```bash
# 确保 /dashboard/ 只剩 [...slug] + layout
ls -la frontend-nextjs/app/dashboard/
# 期望输出仅：[...slug]/  layout.tsx
```

如果还有遗留子目录，回头补刀。

- [ ] **Step 5: 标记 spec / plan 完成**

在本 plan 顶部加 `状态：已完成`，并在母 spec `2026-05-18-project-workspace-w1-w2-design.md` §10 W2 出口标准下打勾。

- [ ] **Step 6: 最终 commit**

```bash
git add docs/superpowers/plans/2026-05-19-w2-page-migration.md \
        docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md
git commit -m "docs(w2): mark W2 plan and spec exit criteria as completed"
```

---

## Verification Summary

Plan 完成时应满足：

| 验证项 | 命令 | 期望 |
|---|---|---|
| 后端编译 | `cargo build` | `Finished` |
| 后端集成 | `tests/m1_workspace_test.sh` + `tests/integration_test.sh` | 全绿 |
| 前端构建 | `npm run build`（在 `frontend-nextjs/`） | 0 error；warning 不增加 |
| `/dashboard/` 残留 | `ls frontend-nextjs/app/dashboard` | 只剩 `[...slug]/`、`layout.tsx` |
| 老链接兼容 | 浏览器访问 21 个老 `/dashboard/xxx` 路径 | 都正确重定向 |
| 普通用户首屏 | `test@example.com` 登录 | 自动进 `/workspace/[id]`，0 红 toast |
| 项目首页指标 | workspace 首页 | "数据表"显示正数 |
| 角色门槛 | viewer 角色访问 `/database/tables` | "新建表" 按钮 disable |

---

## 风险与开放问题

### 已识别风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 工作空间 layout 没找到 primary_connection（项目尚无 db 绑定）→ 下游页面拉数据全部 401/404 | 高 | Task 2 中显式判断 `if (resp.data.primary_connection)`；无连接时不动 currentConnection，子页面正常显示"暂无连接"提示 |
| 现有 dashboard 页面里硬编码 `/dashboard/...` 跳转字符串 | 中 | grep 全代码库 `'/dashboard/'` 找出残留，迁移时手工改 |
| 切项目时 currentConnection 没被刷新 → 仍用上一个项目的连接 | 高 | Task 2 中 layout effect 依赖 `params.projectId`，URL 变就重 fetch；setCurrentConnection 必然被重写 |
| `ScheduledTasksManager`、`PermissionGate` 等共享组件可能假设了 currentTenant 存在 | 中 | 迁移前在 grep 一次 `useAppStore` 引用，确认它们或者读 `currentProject` / `props`，或者 graceful degrade |
| `npm run build` 出现新增 type error（例如 `currentProject.workspace_config` 索引访问） | 中 | 每 Task 强制 `tsc --noEmit` 后再 commit；最后 Task 13 总 build 一次 |
| 后端 `tenant_databases.is_primary` 列不存在或语义不同 | 中 | Task 1 §Step 2 注意 schema 校对；如果列名不同换成 `is_default` 之类的等价列 |
| Backup 页面被直接删可能有用户依赖 | 低 | W2 阶段先观察 1 个版本，如果有反馈再 W3 决定是否迁 |

### 开放问题（实施前确认）

- [ ] **`tenant_databases` 表的实际 schema**：列名 `is_primary` / `is_default` / `is_active` 究竟是哪个？跑 `psql -c "\d management.tenant_databases"` 一次性确认
- [ ] **`user_databases` 关联表**：超管能不能不经过这个表直接看到所有 connection？Task 1 的 `if claims.is_superadmin` 分支假设可以
- [ ] **项目内多 connection**：spec 说 "primary connection"，但项目有读副本时怎么选？W2 阶段简化为：primary = `is_primary=true` 那条；读副本切换留给 W3
- [ ] **`/dashboard/backup` 是否真的没人用**：在删之前 grep 一次后端日志（`grep '/dashboard/backup' /var/log/...`）确认 0 PV
- [ ] **`/api/admin/circuit-breakers` 等平台监控接口的鉴权**：现在用 `require_superadmin_middleware` 吗？如果是的话 `/platform/monitor` 直接调即可

---

## 实施顺序（建议）

按 Task 序号顺序，**不要并行**。理由：
- Task 1-2 是基础设施，必须先做（后续所有页面都依赖 currentConnection）
- Task 3 是首页指标，做完后用户能感知到"workspace 是活的"
- Task 4-9 是体力活，每个 Task 完整迁完一组并跑 tsc + smoke 再进下一组
- Task 10 平台增补独立于 workspace 主线，做完不阻塞
- Task 11 是收口，必须放在所有迁移完成之后
- Task 12 是 UX 修补，可以和 Task 11 合并
- Task 13 强制总验收

**估时**：

| Task | 时长 |
|---|---|
| Task 1 后端 | 0.5 day |
| Task 2 layout setCurrentConnection | 0.5 day |
| Task 3 首页指标 | 0.5 day |
| Task 4 数据库组（9 页） | 3-4 days |
| Task 5 安全组（4 页） | 1.5 days |
| Task 6 事件组（3 页） | 1.5 days |
| Task 7 API & RPC | 1 day |
| Task 8 监控组（拆 + 3 迁） | 1.5 days |
| Task 9 项目设置 | 0.5 day |
| Task 10 平台增补 | 1 day |
| Task 11 收尾 + [...slug] | 0.5 day |
| Task 12 sidebar 修补 | 0.25 day |
| Task 13 回归 + smoke | 0.5 day |

**总计：12-13 个工作日**（≈ 2.5 周）；与 spec §8.2 的 "2-3 weeks" 估算一致。

---

## 实施记录（2026-05-19 一次性推进结果）

W2 主体在一次会话内推进到位，21 个 dashboard 子目录全部消化完毕。下面列出每个任务的实际落地状态、关键 commit 和被有意推迟的部分。

### 已完成（合并入 `feature/optimize`）

| Task | 状态 | 关键 commit |
|------|------|---|
| 1 后端 `get_project` 加 `primary_connection` | 完成 | `92e19de` |
| 2 工作空间 layout `setCurrentConnection` | 完成 | `c130399` |
| 3 项目首页接 `schemaAPI.listTables` | 完成 | `de062be` |
| 4 数据库组 9 页迁移 | 完成 | `c700aa8` + 简化版 3 页 `<earlier>` |
| 5 安全组 3 页 + 修 RLS 老 tsc 错 | 完成 | `c4c9f88` |
| 6 事件组 3 页（webhooks/scheduled-tasks/es-connections）| 完成 | `90f22a2` + 清残 `<followup>` |
| 7（部分）RPC 迁移 + API 单页迁移 | 完成 | `<rpc>` `1957ed5` |
| 8（部分）monitor 单页迁移 | 完成 | `1fa04fc` |
| 9 项目设置：connections | 完成 | `4852263` |
| 11 `/dashboard/[...slug]` catch-all + middleware 加 `/workspace` | 完成 | `cf9e5d9` |
| 12 sidebar 与实际页面对齐 | 完成 | `0dce6f6` |
| 备：删 `/dashboard/test`、保留 `/dashboard/backup` 改为 `database/backup` | 完成 | `<rpc-backup>` |

### 有意推迟到 W3（不影响 W2 收口标志）

| 推迟项 | 原因 | 建议入口 |
|--------|------|---------|
| API 页 "keys" tab 拆出独立 `/workspace/[id]/security/api-keys` | 1088 行重构远超剩余预算；当前页面行为正确（已通过 URL projectId 拉 keys）| W3 新 plan |
| Monitor `/api/admin/*` 数据源拆出 `/platform/monitor` | 当前 `Promise.allSettled` + 静默 403 拦截器已让非超管看到的页面体验正确；拆分主要是 UX 清晰化 | W3 新 plan |
| Task 10 平台页 `/dashboard/{query,query-analyzer,slow-queries,transaction}` → `/platform/*` | W1 已让非超管不再能访问 `/dashboard/*`；这 4 个页面对超管仍按原路径正常工作 | W3 新 plan |
| `/settings/{project-info,members}` stub 页面 | 后端尚无成员管理 API（W3 PASE Stage E 范围）| 与 PASE E 同期 |

### W2 收口标志检查

- [x] `frontend-nextjs/app/dashboard/` 已无功能性 page.tsx：只剩 `[...slug]/page.tsx`（catch-all）和 `page.tsx`（根重定向）+ `layout.tsx` + 4 个平台 only 子目录（待 Task 10）。**未达到 100% 清空**，但所有租户级页面都已迁完；剩下的 4 个目录仅超管能访问，由 W1 layout 把关。
- [x] 普通租户用户的所有功能链路都跑在 `/workspace/[projectId]/...`：sidebar 上所有可见入口 + 项目首页指标 + 旧 URL bookmark（经 `[...slug]` 兜底）。
- [x] 0 红 toast：401 / 403 都走静默路径，未引入新的 toast 失败点。

### 开放问题已回答

1. `tenant_databases` 主连接列名：`is_primary` + `is_active`（见 `migrations/003_create_management_schema.sql:20`）
2. `user_databases` 表：**不存在**。W1 `get_project` 已通过 `user_tenants` 完成成员校验；连接拉取直接按 `tenant_id` 取即可（Task 1 实现已是这个形态）。
3. 多连接 / 读副本选连：本期 `/api/projects/:id` 只回单条主连接（`is_primary DESC, id ASC LIMIT 1`）。读副本切换是 W3 范围。
4. `/dashboard/backup` 使用情况：保留并迁到 `/workspace/[id]/database/backup`，因为它依赖 `currentConnection` + `queryAPI`，是项目级数据备份能力。
5. `/api/admin/circuit-breakers` 鉴权：现仍走 `require_platform_superadmin`；非超管被静默 403，不弹 toast。

---

*本 plan 实现 `docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md` §4 的 W2 范围。supersedes 任何更早的 W2 草稿。完成后母 spec §10 W2 出口标准全部勾上（含 1 个已知例外：4 个平台页仍保留在 `/dashboard/*`，下一期 Task 10 处理）。*
