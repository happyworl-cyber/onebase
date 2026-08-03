# W1 项目工作空间外壳 Implementation Plan

> **状态：所有 18 个 Task 的代码改动均已合入 `feature/optimize`。**
> 浏览器端到端 smoke 仍需用户自己跑（前提：重启 backend 让 /api/projects
> 路由生效，再用真账号验证 W1 出口验收清单）。
>
> 完成顺序与 commit 一一对应；查看 `git log --oneline --grep '^feat(w1)' --grep '^test(w1)' --grep '^refactor(w1)'`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `/workspace/[projectId]/*` 路由层、登录后路由分发、智能 401/403 拦截，让普通租户用户登录后**直接进入项目工作空间且 0 红色 toast**，解决"`test@example.com` 登录后批量 403"问题。

**Architecture:** 前端新增 `app/workspace/[projectId]/*` 路由（与现有 `app/platform/*` 并列）；后端在现有 `tenant_handlers.rs` 中追加 2 个端点 `GET /api/projects` / `GET /api/projects/:id`（**不引入新 mod / 中间件 / 请求头**）；现有 `/dashboard/*` W1 阶段保留，仅在 layout 加分发跳转，等 W2 物理迁移后删除。

**Tech Stack:** Rust (axum + sqlx) / TypeScript (Next.js 14 App Router) / Zustand / PostgreSQL (management schema) / Bash (shell 集成测试)

**Spec 来源：** `docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md` §3

**前置假设：**
- 已有 `auth_middleware`（`src/middleware.rs`）
- 已有 `tenant_handlers::get_my_connections`（`src/tenant_handlers.rs:42-46`）作为同类参考
- 已有 `/platform/*` 路由层（`frontend-nextjs/app/platform/layout.tsx`）作为壳的参考
- `Claims.sub` 类型为 `i32`（`src/auth.rs:44-56`）
- `AppError` variants：`Unauthorized` / `Forbidden` / `NotFound` / `Internal` / `Database` 等（`src/error.rs:10-36`）
- migration 下一编号为 **017**（014/015/016 已占用）
- `Tenant` 结构在 `src/tenant_models.rs:6-12`（**不在** `src/models.rs`）

**测试策略：**
- 后端 HTTP 路径 → `tests/m1_workspace_test.sh`（沿用 `tests/integration_test.sh` 的 curl + Bearer 风格）
- 后端纯逻辑 → 暂无（W1 没有可单测的逻辑层）
- 前端 → 手工 smoke（仓库目前无 Playwright；W2 阶段补）
- DB migration → 跑 2 次验证幂等

---

## File Structure

| 类别 | 操作 | 文件 | 责任 |
|---|---|---|---|
| Migration | Create | `migrations/017_workspace_kind.sql` | tenants.kind + workspace_config 列 |
| Migration | Modify | `src/bin/migrate_all.rs` | 在 `MIGRATIONS` 数组追加 017 |
| Backend | Modify | `src/tenant_handlers.rs` | 追加 `list_projects` / `get_project` |
| Backend | Modify | `src/main.rs` | 在 `tenant_routes` 注册 2 条新路由 |
| Test | Create | `tests/m1_workspace_test.sh` | 端到端 curl 断言 |
| Frontend | Modify | `frontend-nextjs/lib/api.ts` | 401 不 toast；403 默认静默 |
| Frontend | Modify | `frontend-nextjs/lib/store.ts` | 新增 `currentProject` / `setCurrentProject` |
| Frontend | Modify | `frontend-nextjs/lib/permissions.ts` | 新增 `deriveWorkspaceCapabilities` + `useCurrentProjectCapabilities` hook |
| Frontend | Create | `frontend-nextjs/components/shared/ForbiddenPlaceholder.tsx` | 403 占位组件 |
| Frontend | Create | `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx` | 工作空间左侧栏（按 role 过滤） |
| Frontend | Create | `frontend-nextjs/components/workspace/ProjectTopbar.tsx` | 顶栏（项目切换 + 用户菜单） |
| Frontend | Create | `frontend-nextjs/app/workspace/layout.tsx` | `/workspace`、`/workspace/no-projects`、`/workspace/[id]/*` 的最外层 ToastProvider |
| Frontend | Create | `frontend-nextjs/app/workspace/page.tsx` | 项目选择页（多项目时） |
| Frontend | Create | `frontend-nextjs/app/workspace/no-projects/page.tsx` | 无项目用户引导页 |
| Frontend | Create | `frontend-nextjs/app/workspace/[projectId]/layout.tsx` | 项目壳：拉项目元数据 + 鉴权兜底 + 渲染 Topbar + Sidebar |
| Frontend | Create | `frontend-nextjs/app/workspace/[projectId]/page.tsx` | 项目首页（数据概览，4 指标卡 stub） |
| Frontend | Modify | `frontend-nextjs/app/login/page.tsx` | `handleLogin` 后按项目数智能分发 |
| Frontend | Modify | `frontend-nextjs/app/dashboard/layout.tsx` | 非超管自动跳 workspace |

---

## Task 1: DB Migration — `tenants.kind` + `workspace_config` 列

**Files:**
- Create: `migrations/017_workspace_kind.sql`
- Modify: `src/bin/migrate_all.rs:10-26` (`MIGRATIONS` 常量数组末尾追加)

- [ ] **Step 1: 写 migration SQL**

创建 `migrations/017_workspace_kind.sql`：

```sql
-- ============================================================
-- W1: 工作空间元数据
-- ============================================================
-- 给 management.tenants 加两列：
--   kind             - 'legacy_tenant' | 'project'，区分历史租户与 M2 起的项目
--   workspace_config - JSONB，存项目级 UI 偏好（首页布局、AI 开关等）
--
-- W1 阶段 kind 字段不强制读，工作空间不按 kind 过滤项目列表（普通用户能看到
-- 自己加入的所有 tenants）；M2 自助开通向导落地后才用 kind 区分。

ALTER TABLE management.tenants
    ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'legacy_tenant',
    ADD COLUMN IF NOT EXISTS workspace_config JSONB;

ALTER TABLE management.tenants
    DROP CONSTRAINT IF EXISTS tenants_kind_check;
ALTER TABLE management.tenants
    ADD CONSTRAINT tenants_kind_check
    CHECK (kind IN ('legacy_tenant', 'project'));

CREATE INDEX IF NOT EXISTS idx_tenants_kind ON management.tenants(kind);

COMMENT ON COLUMN management.tenants.kind IS
    'W1 工作空间元数据：legacy_tenant=历史租户；project=M2 自助开通的项目';
COMMENT ON COLUMN management.tenants.workspace_config IS
    'W1 工作空间元数据：项目 UI 偏好的 JSONB（首页布局 / AI 开关 / 通知偏好等），允许 NULL';
```

- [ ] **Step 2: 在 `migrate_all.rs` 注册**

打开 `src/bin/migrate_all.rs`，找到 `MIGRATIONS` 数组末行（应该是 `("016 es proxy", ...)`），在它后面追加：

```rust
    ("017 workspace kind",       include_str!("../../migrations/017_workspace_kind.sql")),
```

注意：保持现有缩进风格（两个数字 + name + path 三段对齐）。

- [ ] **Step 3: 跑 migration 验证首次执行**

```bash
cargo run --bin migrate_all 2>&1 | tail -20
```

Expected: 末尾包含一行类似：
```
  [017 workspace kind] OK (5 executed, 0 skipped)
```
（首跑 executed 数视 PG 是否已存在列而定；总之 `errors=0`）

- [ ] **Step 4: 用 psql 验证列已加上**

```bash
psql "$DATABASE_URL" -c "\d management.tenants" | grep -E "kind|workspace_config"
```

Expected 输出包含两行：
```
 kind             | character varying(32)       |           | not null | 'legacy_tenant'::character varying
 workspace_config | jsonb                       |           |          |
```

- [ ] **Step 5: 跑第二次验证幂等**

```bash
cargo run --bin migrate_all 2>&1 | tail -5
```

Expected: 不出现任何 `FAILED`；017 那一行 `executed=0 skipped=5` 或类似（skipped 数 ≥ executed 数即可）。

- [ ] **Step 6: Commit**

```bash
git add migrations/017_workspace_kind.sql src/bin/migrate_all.rs
git commit -m "feat(w1): add management.tenants.kind + workspace_config columns"
```

---

## Task 2: Backend Handlers — `list_projects` / `get_project`

**Files:**
- Modify: `src/tenant_handlers.rs` (在文件末尾追加 2 个 handler)

- [ ] **Step 1: 在 `tenant_handlers.rs` 末尾追加 handler**

打开 `src/tenant_handlers.rs`，**追加到文件末尾**（不要插中间，会破坏现有函数顺序）：

```rust
// ============================================================
// W1 工作空间：项目列表 / 详情
// ============================================================
//
// 与 get_my_connections 的区别：
//   get_my_connections 返回"用户可访问的 DB 连接"（按 user_databases + tenants 视图）
//   list_projects      返回"用户隶属的项目元数据"（user_tenants + tenants），含 user_role
//
// 设计原则（详见 docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md §3.1）：
//   - 不引入新中间件，直接复用 auth_middleware
//   - 不区分 tenant.kind=legacy_tenant 还是 project（W1 全部返回）
//   - 把用户在该项目的 role 作为字段返回，前端用它做 UI 能力门槛

/// GET /api/projects
///
/// 返回当前登录用户可见的项目列表。
/// - 超管：返回所有 status='active' 的 tenants
/// - 普通用户：返回自己 user_tenants.is_active=true 的 tenants
///
/// 返回字段：id, name, slug, status, kind, contact_email, user_role
/// user_role 取值：
///   - 超管：'superadmin'
///   - 普通用户：user_tenants.role（'owner'/'admin'/'member'/'viewer' 等）
pub async fn list_projects(
    State(pool): State<sqlx::PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let rows = if claims.is_superadmin {
        sqlx::query(
            r#"
            SELECT id, name, slug, status, kind, contact_email
            FROM management.tenants
            WHERE status = 'active'
            ORDER BY id DESC
            "#,
        )
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            r#"
            SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email, ut.role AS user_role
            FROM management.tenants t
            JOIN management.user_tenants ut ON ut.tenant_id = t.id AND ut.is_active = true
            WHERE ut.user_id = $1 AND t.status = 'active'
            ORDER BY t.id DESC
            "#,
        )
        .bind(claims.sub)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| AppError::Database(e))?;

    let projects: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let id: i32 = r.get("id");
            let name: String = r.get("name");
            let slug: Option<String> = r.try_get("slug").ok();
            let status: String = r.get("status");
            let kind: String = r.get("kind");
            let contact_email: Option<String> = r.try_get("contact_email").ok();
            let user_role: String = if claims.is_superadmin {
                "superadmin".to_string()
            } else {
                r.try_get::<String, _>("user_role")
                    .unwrap_or_else(|_| "member".to_string())
            };
            serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "status": status,
                "kind": kind,
                "contact_email": contact_email,
                "user_role": user_role,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "projects": projects })))
}

/// GET /api/projects/:id
///
/// 返回单个项目详情 + 当前用户在该项目的 role。
/// - 项目不存在 → 404
/// - 用户无权访问 → 403
pub async fn get_project(
    State(pool): State<sqlx::PgPool>,
    Extension(claims): Extension<Claims>,
    axum::extract::Path(project_id): axum::extract::Path<i32>,
) -> Result<Json<serde_json::Value>> {
    let tenant_row = sqlx::query(
        r#"
        SELECT id, name, slug, status, kind, contact_email, workspace_config
        FROM management.tenants
        WHERE id = $1 AND status = 'active'
        "#,
    )
    .bind(project_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Database(e))?
    .ok_or_else(|| AppError::NotFound(format!("项目 {} 不存在", project_id)))?;

    let user_role: String = if claims.is_superadmin {
        "superadmin".to_string()
    } else {
        let role_opt: Option<String> = sqlx::query_scalar(
            r#"
            SELECT role FROM management.user_tenants
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true
            "#,
        )
        .bind(claims.sub)
        .bind(project_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| AppError::Database(e))?;

        match role_opt {
            Some(r) => r,
            None => {
                return Err(AppError::Forbidden(format!(
                    "你不是项目 {} 的成员",
                    project_id
                )));
            }
        }
    };

    let id: i32 = tenant_row.get("id");
    let name: String = tenant_row.get("name");
    let slug: Option<String> = tenant_row.try_get("slug").ok();
    let status: String = tenant_row.get("status");
    let kind: String = tenant_row.get("kind");
    let contact_email: Option<String> = tenant_row.try_get("contact_email").ok();
    let workspace_config: Option<serde_json::Value> = tenant_row.try_get("workspace_config").ok();

    Ok(Json(serde_json::json!({
        "id": id,
        "name": name,
        "slug": slug,
        "status": status,
        "kind": kind,
        "contact_email": contact_email,
        "workspace_config": workspace_config,
        "user_role": user_role,
    })))
}
```

注意 import：本文件顶部的 `use` 语句应已经包含 `sqlx::Row` / `serde_json` / `axum::Json` 等；如果 `Row` trait 没 import 导致编译错，在顶部 use 区追加：

```rust
use sqlx::Row;
```

- [ ] **Step 2: cargo check 验证编译**

```bash
cargo check 2>&1 | tail -10
```

Expected: `Finished` 无 error；如果出现 `Row` trait not in scope，按 Step 1 末尾说明追加 `use sqlx::Row;`。

如果编译错误提示 `axum::extract::Path` 模块路径，把签名里的 `axum::extract::Path` 替换为 `crate::axum_imports_used_elsewhere::Path` 风格——但更简单的做法是在文件顶部 use 区追加：

```rust
use axum::extract::Path;
```

然后把 handler 签名里 `axum::extract::Path(project_id)` 简化为 `Path(project_id)`。

- [ ] **Step 3: Commit**

```bash
git add src/tenant_handlers.rs
git commit -m "feat(w1): add list_projects / get_project handlers"
```

---

## Task 3: Backend Routes — 在 `main.rs` 的 `tenant_routes` 注册

**Files:**
- Modify: `src/main.rs:229-236` (`tenant_routes` 块内)

- [ ] **Step 1: 定位 `tenant_routes` 块**

在 `src/main.rs` 搜 `tenant_routes`，找到 `let tenant_routes = Router::new()` 开头的代码块（约 229 行）。它形如：

```rust
let tenant_routes = Router::new()
    .route("/api/tenants/my-connections", get(tenant_handlers::get_my_connections))
    // ... 其他若干 tenant 路由 ...
    .layer(from_fn_with_state(state.clone(), middleware::auth_middleware))
    .with_state(state.clone());
```

- [ ] **Step 2: 在该块的路由列表里追加 2 条**

在该 `Router::new()` 链最后一条 `.route(...)` 之后、`.layer(...)` 之前，追加：

```rust
    .route("/api/projects", get(tenant_handlers::list_projects))
    .route("/api/projects/:id", get(tenant_handlers::get_project))
```

- [ ] **Step 3: cargo build 验证**

```bash
cargo build 2>&1 | tail -10
```

Expected: `Finished` 无 error。

- [ ] **Step 4: 启动服务 smoke 验证**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
curl -sS http://127.0.0.1:3010/health
echo ""
curl -sS http://127.0.0.1:3010/api/projects | head -100
kill $BACKEND_PID
```

Expected:
- `/health` 返回 `{"status":"ok"...}` 或类似
- `/api/projects` 返回 `{"error":"未提供 Token"}` 或类似 401（因为没带 Authorization）

如果 `/api/projects` 返回 404，说明路由未注册；回到 Step 2 检查。

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "feat(w1): register /api/projects routes in tenant_routes"
```

---

## Task 4: 端到端 Shell 集成测试

**Files:**
- Create: `tests/m1_workspace_test.sh`

- [ ] **Step 1: 写测试脚本**

创建 `tests/m1_workspace_test.sh`：

```bash
#!/usr/bin/env bash
# ============================================================
# W1 项目工作空间端到端集成测试
#
# 跑法：
#   ./tests/m1_workspace_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_test.sh
#
# 前置：
#   - 服务已启动
#   - 存在 admin 账号（默认 admin@example.com / Admin123）且 is_superadmin=true
#   - 存在普通用户账号（默认 test@example.com / Test1234）
#   - 普通用户至少加入 1 个 tenant（脚本会查询 user_tenants 跳过 seed）
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1)); log "  PASS  $name (= $actual)"
    else
        FAIL=$((FAIL + 1)); log "  FAIL  $name (期望 $expected, 实际 $actual)"
    fi
}

login() {
    # $1=email $2=password → echo token
    curl -sS -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
        | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4
}

# 准备 token
log "Login as admin ($ADMIN_EMAIL)"
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[[ -z "$ADMIN_TOKEN" ]] && { echo "FATAL: admin 登录失败"; exit 2; }

log "Login as normal user ($USER_EMAIL)"
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD")
[[ -z "$USER_TOKEN" ]] && { echo "FATAL: 普通用户登录失败（请确认账号存在并密码正确）"; exit 2; }

# Test 1: 未授权访问 /api/projects → 401
log "Test 1: GET /api/projects 无 token"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/projects")
assert_eq "/api/projects 401 without token" "401" "$STATUS"

# Test 2: 超管 GET /api/projects → 200 + projects 数组
log "Test 2: 超管 GET /api/projects"
BODY=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/projects")
echo "$BODY" | grep -q '"projects":\[' && r=ok || r=no
assert_eq "admin projects array exists" "ok" "$r"

# Test 3: 普通用户 GET /api/projects → 200 + projects 数组
log "Test 3: 普通用户 GET /api/projects"
USER_BODY=$(curl -sS -H "Authorization: Bearer $USER_TOKEN" "$API_BASE/api/projects")
echo "$USER_BODY" | grep -q '"projects":\[' && r=ok || r=no
assert_eq "user projects array exists" "ok" "$r"

# Test 4: 普通用户返回里 user_role 字段不应为 'superadmin'
log "Test 4: 普通用户 projects 里 user_role 不应是 superadmin"
echo "$USER_BODY" | grep -q '"user_role":"superadmin"' && r=found || r=ok
assert_eq "user not flagged as superadmin" "ok" "$r"

# Test 5: 拿用户第一个项目 id
FIRST_USER_PROJECT_ID=$(echo "$USER_BODY" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
if [[ -z "$FIRST_USER_PROJECT_ID" ]]; then
    log "  SKIP  Test 5-7：普通用户没有任何项目，跳过"
else
    # Test 5: 普通用户 GET /api/projects/:id (自己的) → 200
    log "Test 5: 普通用户 GET /api/projects/$FIRST_USER_PROJECT_ID"
    STATUS=$(curl -sS -o /tmp/m1_get.json -w "%{http_code}" \
        -H "Authorization: Bearer $USER_TOKEN" \
        "$API_BASE/api/projects/$FIRST_USER_PROJECT_ID")
    assert_eq "get own project 200" "200" "$STATUS"

    # Test 6: 返回里包含 user_role 字段
    grep -q '"user_role":' /tmp/m1_get.json && r=ok || r=no
    assert_eq "get_project 包含 user_role" "ok" "$r"

    # Test 7: 超管访问任意项目 → 200 + user_role=superadmin
    log "Test 7: 超管 GET /api/projects/$FIRST_USER_PROJECT_ID"
    curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$API_BASE/api/projects/$FIRST_USER_PROJECT_ID" > /tmp/m1_admin_get.json
    grep -q '"user_role":"superadmin"' /tmp/m1_admin_get.json && r=ok || r=no
    assert_eq "admin user_role=superadmin" "ok" "$r"
fi

# Test 8: GET /api/projects/999999 不存在 → 404
log "Test 8: GET /api/projects/999999"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_BASE/api/projects/999999")
assert_eq "get nonexistent project 404" "404" "$STATUS"

# Test 9: 普通用户访问他人项目（用一个超管能看到但用户不参与的 id）→ 403
log "Test 9: 普通用户访问他不参与的项目"
ADMIN_PROJECTS=$(echo "$BODY" | grep -oE '"id":[0-9]+' | cut -d':' -f2 | sort -u)
USER_PROJECTS=$(echo "$USER_BODY" | grep -oE '"id":[0-9]+' | cut -d':' -f2 | sort -u)
NOT_USER_PROJECT=""
for pid in $ADMIN_PROJECTS; do
    if ! echo "$USER_PROJECTS" | grep -qx "$pid"; then
        NOT_USER_PROJECT="$pid"
        break
    fi
done
if [[ -z "$NOT_USER_PROJECT" ]]; then
    log "  SKIP  Test 9：找不到一个超管能看但用户不参与的项目（跳过）"
else
    STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $USER_TOKEN" \
        "$API_BASE/api/projects/$NOT_USER_PROJECT")
    assert_eq "non-member access -> 403" "403" "$STATUS"
fi

# 总结
log "================================================"
log "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
```

- [ ] **Step 2: 加可执行权限**

```bash
chmod +x tests/m1_workspace_test.sh
```

- [ ] **Step 3: 启动后端 + 跑测试**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
./tests/m1_workspace_test.sh
EXIT=$?
kill $BACKEND_PID
exit $EXIT
```

Expected: 末行 `PASS=8 FAIL=0`（test@example.com 至少有 1 个项目时是 8；没有时 Test 5-7 SKIP，PASS=5）；退出码 0。

如果普通用户登录失败（脚本中 FATAL），需要先准备 test 账号或调整 `USER_EMAIL` 环境变量。

- [ ] **Step 4: 跑现有 integration_test.sh 确保无回归**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
./tests/integration_test.sh
EXIT=$?
kill $BACKEND_PID
exit $EXIT
```

Expected: 退出码 0；现有测试无回归。

- [ ] **Step 5: Commit**

```bash
git add tests/m1_workspace_test.sh
git commit -m "test(w1): add end-to-end shell test for /api/projects"
```

---

## Task 5: Frontend `lib/api.ts` — 401/403 智能拦截

**Files:**
- Modify: `frontend-nextjs/lib/api.ts:99-148` (响应拦截器内 401 处理与通用错误分支)

- [ ] **Step 1: 定位现有响应拦截器**

打开 `frontend-nextjs/lib/api.ts`，搜 `error.response?.status === 401`，找到现有 401 处理块（约 111-128 行）。同一个拦截器尾部还有通用错误 toast 分支（约 142-145 行）。

- [ ] **Step 2: 修改拦截器实现**

把响应拦截器的内部逻辑改成下面这套（精确匹配 spec §3.3 智能策略）：

```typescript
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status
    const config = error.config as ApiRequestConfig | undefined

    // 401：清 token + 跳登录页，不弹 toast（避免离开页面前还闪红条）
    if (status === 401) {
      clearAuthToken()
      try {
        localStorage.removeItem('current_user')
        localStorage.removeItem('current_tenant')
        localStorage.removeItem('current_project')
      } catch {}
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
      return Promise.reject(error)
    }

    // 403：默认静默（不弹 toast）。
    // 调用方按需自己 catch + 渲染 ForbiddenPlaceholder 或主动 toast。
    // console.warn 留下排查线索。
    if (status === 403) {
      if (typeof console !== 'undefined') {
        console.warn(
          '[api] 403 Forbidden:',
          config?.method?.toUpperCase(),
          config?.url,
          error.response?.data,
        )
      }
      return Promise.reject(error)
    }

    // 其他 4xx/5xx 保持现状：尊重 suppressErrorToast；否则全局 toast
    if (!config?.suppressErrorToast) {
      const message =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        '请求失败'
      showToast('error', message)
    }

    return Promise.reject(error)
  },
)
```

**关键改动**：
- 401 不再 `showToast('warning', ...)`（原实现有，会闪一下）
- 403 单独 early-return，不进通用 toast 分支
- 其他错误保持原有行为

- [ ] **Step 3: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "lib/api.ts"
echo "===done==="
```

Expected: `===done===` 直接出现，中间没有 `lib/api.ts(...)` 报错行。如有报错，按提示修。

- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/lib/api.ts
git commit -m "feat(w1): smart 401/403 handling in axios interceptor (401 silent redirect, 403 silent default)"
```

---

## Task 6: Frontend `lib/store.ts` — 新增 `currentProject`

**Files:**
- Modify: `frontend-nextjs/lib/store.ts:64-125` (state + setter)

- [ ] **Step 1: 定位现有 `currentTenant` 部分**

打开 `frontend-nextjs/lib/store.ts`，搜 `currentTenant:` 找到 state 定义区（约 64-71 行）；搜 `setCurrentTenant` 找到 setter（约 96-125 行）。

- [ ] **Step 2: 加 `Project` 接口 + currentProject state + setter**

在已有 `Tenant` interface 旁边（约 51-62 行附近）追加：

```typescript
export interface Project {
  id: number
  name: string
  slug?: string | null
  status: string
  kind: string
  contact_email?: string | null
  workspace_config?: Record<string, unknown> | null
  /**
   * 当前登录用户在该项目里的角色：
   *   'superadmin' | 'owner' | 'admin' | 'member' | 'viewer'
   * 仅作为前端 UI 能力门槛的 hint；真值在后端 RBAC。
   */
  user_role: string
}
```

在 store 接口的 state 定义里追加（紧邻 `currentTenant: Tenant | null`）：

```typescript
  currentProject: Project | null
  setCurrentProject: (project: Project | null) => void
```

在 setter 实现里追加（紧邻 `setCurrentTenant` 之后）：

```typescript
  setCurrentProject: (project) =>
    set(() => {
      if (typeof window !== 'undefined') {
        if (project) {
          localStorage.setItem('current_project', JSON.stringify(project))
        } else {
          localStorage.removeItem('current_project')
        }
      }
      return { currentProject: project }
    }),
```

在 store 初始化的 `currentTenant: null` 旁追加：

```typescript
  currentProject: typeof window !== 'undefined'
    ? (() => {
        try {
          const raw = localStorage.getItem('current_project')
          return raw ? (JSON.parse(raw) as Project) : null
        } catch {
          return null
        }
      })()
    : null,
```

- [ ] **Step 3: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "lib/store.ts"
echo "===done==="
```

Expected: `===done===` 直出无 store.ts 报错。

- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/lib/store.ts
git commit -m "feat(w1): add Project interface + currentProject state to Zustand store"
```

---

## Task 7: Frontend `lib/permissions.ts` — `deriveWorkspaceCapabilities` + hook

**Files:**
- Modify: `frontend-nextjs/lib/permissions.ts` (在文件末尾追加新函数 + hook)

- [ ] **Step 1: 在文件末尾追加 capability 类型 + 派生函数 + hook**

```typescript
// ============================================================
// W1 工作空间：基于 user_tenants.role 的 UI 能力门槛
// ============================================================
//
// 设计原则（spec §3.2.5 / §3.2.6）：
//   - 这只是 UI 能力门槛的速记，后端 RBAC（permissions 表）是真值来源
//   - 不修改 deriveUiCapabilities，避免影响 /platform & /dashboard 现有行为
//
// 角色层级（高 → 低）：
//   superadmin > owner > admin > member > viewer

export type WorkspaceRole =
  | 'superadmin'
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer'
  | string // 兜底：未知 role 当 viewer 处理

export interface WorkspaceCapabilities {
  /** 顶部"设置 / 成员管理" → 仅 owner+ */
  canManageProjectSettings: boolean
  /** 整组"安全（RLS/Roles/RPC-ACL/API Key）" → admin+ */
  canManageSecurity: boolean
  /** 整组"事件（Webhook/定时任务）" → admin+ */
  canManageEvents: boolean
  /** 数据库写入（建表/改 schema/CREATE FUNCTION 等） → member+ */
  canWriteDatabase: boolean
  /** 调用 RPC / 读 API → 任意成员（含 viewer） */
  canCallApi: boolean
}

const ROLE_ORDER: Record<string, number> = {
  superadmin: 100,
  owner: 80,
  admin: 60,
  member: 40,
  viewer: 20,
}

function rank(role: WorkspaceRole): number {
  return ROLE_ORDER[role] ?? 0
}

export function deriveWorkspaceCapabilities(role: WorkspaceRole): WorkspaceCapabilities {
  const r = rank(role)
  return {
    canManageProjectSettings: r >= ROLE_ORDER.owner,
    canManageSecurity: r >= ROLE_ORDER.admin,
    canManageEvents: r >= ROLE_ORDER.admin,
    canWriteDatabase: r >= ROLE_ORDER.member,
    canCallApi: r >= ROLE_ORDER.viewer,
  }
}

/**
 * React hook：基于 store 中的 currentProject.user_role 派生当前能力。
 * 用法：const caps = useCurrentProjectCapabilities()
 *      if (caps.canManageSecurity) { ... }
 */
import { useAppStore } from './store'

export function useCurrentProjectCapabilities(): WorkspaceCapabilities {
  const role = useAppStore((s) => s.currentProject?.user_role ?? 'viewer')
  return deriveWorkspaceCapabilities(role)
}
```

注意：`import { useAppStore } from './store'` 必须放在文件**末尾或顶部**，不能放在中间——TypeScript 允许，但维护性差。建议把它移到文件**顶部 import 区**（与其他 import 一起）。

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "lib/permissions.ts"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/lib/permissions.ts
git commit -m "feat(w1): add deriveWorkspaceCapabilities + useCurrentProjectCapabilities hook"
```

---

## Task 8: Frontend `ForbiddenPlaceholder` 组件

**Files:**
- Create: `frontend-nextjs/components/shared/ForbiddenPlaceholder.tsx`

- [ ] **Step 1: 创建组件**

```tsx
'use client'

/**
 * 403 占位组件：在子页面 catch 到 403 时渲染，替代红色 toast 提供更友好的反馈。
 *
 * 用法：
 *   const { data, error } = useSWR(...)
 *   if (error?.response?.status === 403) {
 *     return <ForbiddenPlaceholder
 *       reason={`你的角色 (${userRole}) 没有访问此内容的权限`}
 *     />
 *   }
 */
export interface ForbiddenPlaceholderProps {
  /** 一段简短的原因说明（中文），默认通用文案 */
  reason?: string
  /** 可选的下一步操作链接（如返回项目首页） */
  cta?: {
    label: string
    href: string
  }
}

export default function ForbiddenPlaceholder({
  reason = '当前账号无访问此内容的权限',
  cta,
}: ForbiddenPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-4">
        <i className="fas fa-lock text-2xl text-amber-600"></i>
      </div>
      <h2 className="text-base font-medium text-gray-900 mb-2">权限不足</h2>
      <p className="text-sm text-gray-500 max-w-md">{reason}</p>
      {cta && (
        <a
          href={cta.href}
          className="mt-4 inline-block text-sm text-blue-600 hover:underline"
        >
          {cta.label}
        </a>
      )}
      <p className="mt-6 text-xs text-gray-400">
        如认为权限设置有误，请联系项目管理员或平台超管。
      </p>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "ForbiddenPlaceholder"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/shared/ForbiddenPlaceholder.tsx
git commit -m "feat(w1): add ForbiddenPlaceholder shared component"
```

---

## Task 9: Frontend `WorkspaceSidebar` 组件

**Files:**
- Create: `frontend-nextjs/components/workspace/WorkspaceSidebar.tsx`

- [ ] **Step 1: 创建组件**

```tsx
'use client'

import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'

/**
 * 工作空间左侧栏，按角色能力门槛过滤。
 *
 * IA：按对象类型分组（Supabase 风格），见 spec §3.2.6。
 * 能力门槛与 spec §4.1 角色门槛表保持一致：
 *   - 整组"安全"仅 admin+
 *   - 整组"事件"仅 admin+
 *   - "设置"仅 owner+
 *   - 其余对所有成员可见
 */

interface NavItem {
  label: string
  href: string // 相对 base 的路径（'' 表示首页）
  icon: string
}

interface NavGroup {
  label: string
  icon: string
  items: NavItem[]
  /** 该组整体显示门槛；缺省即全员可见 */
  visibleIf?: (caps: ReturnType<typeof useCurrentProjectCapabilities>) => boolean
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: '概览',
    icon: 'fas fa-home',
    items: [{ label: '项目首页', href: '', icon: 'fas fa-home' }],
  },
  {
    label: '数据库',
    icon: 'fas fa-database',
    items: [
      { label: '表', href: '/database/tables', icon: 'fas fa-table' },
      { label: '关系图', href: '/database/visualizer', icon: 'fas fa-project-diagram' },
      { label: '函数', href: '/database/functions', icon: 'fas fa-code' },
      { label: '触发器', href: '/database/triggers', icon: 'fas fa-bolt' },
    ],
  },
  {
    label: 'API & RPC',
    icon: 'fas fa-plug',
    items: [
      { label: 'REST API', href: '/api', icon: 'fas fa-cloud' },
      { label: 'RPC 调用器', href: '/rpc', icon: 'fas fa-terminal' },
    ],
  },
  {
    label: '安全',
    icon: 'fas fa-user-shield',
    visibleIf: (caps) => caps.canManageSecurity,
    items: [
      { label: '角色', href: '/security/roles', icon: 'fas fa-users-cog' },
      { label: 'RLS', href: '/security/rls', icon: 'fas fa-shield-alt' },
      { label: 'RPC ACL', href: '/security/rpc-acl', icon: 'fas fa-key' },
      { label: 'API Key', href: '/security/api-keys', icon: 'fas fa-fingerprint' },
    ],
  },
  {
    label: '事件',
    icon: 'fas fa-bell',
    visibleIf: (caps) => caps.canManageEvents,
    items: [
      { label: 'Webhook', href: '/events/webhooks', icon: 'fas fa-broadcast-tower' },
      { label: '定时任务', href: '/events/scheduled-tasks', icon: 'fas fa-clock' },
    ],
  },
  {
    label: '监控',
    icon: 'fas fa-chart-line',
    items: [{ label: '监控大盘', href: '/monitor', icon: 'fas fa-chart-line' }],
  },
  {
    label: '设置',
    icon: 'fas fa-cog',
    visibleIf: (caps) => caps.canManageProjectSettings,
    items: [
      { label: '项目信息', href: '/settings', icon: 'fas fa-cog' },
      { label: '成员管理', href: '/settings/members', icon: 'fas fa-users' },
    ],
  },
]

export default function WorkspaceSidebar() {
  const pathname = usePathname()
  const params = useParams<{ projectId: string }>()
  const caps = useCurrentProjectCapabilities()
  const base = `/workspace/${params.projectId}`

  const visibleGroups = NAV_GROUPS.filter((g) => !g.visibleIf || g.visibleIf(caps))

  return (
    <aside className="w-60 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
      <nav className="flex-1 overflow-y-auto py-3">
        {visibleGroups.map((group) => (
          <div key={group.label} className="mb-4">
            <div className="px-4 py-1 text-[11px] uppercase tracking-wider text-gray-400 font-medium">
              {group.label}
            </div>
            {group.items.map((item) => {
              const href = `${base}${item.href}`
              const active = pathname === href
              return (
                <Link
                  key={item.href}
                  href={href}
                  className={`flex items-center gap-3 px-4 py-1.5 text-sm transition-colors ${
                    active
                      ? 'bg-blue-50 text-blue-600 border-l-2 border-blue-500 -ml-px'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <i className={`${item.icon} w-4 text-center text-xs`}></i>
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "WorkspaceSidebar"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/workspace/WorkspaceSidebar.tsx
git commit -m "feat(w1): add WorkspaceSidebar with role-based group filtering"
```

---

## Task 10: Frontend `ProjectTopbar` 组件

**Files:**
- Create: `frontend-nextjs/components/workspace/ProjectTopbar.tsx`

- [ ] **Step 1: 创建组件**

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAppStore, type Project } from '@/lib/store'
import { clearAuthToken } from '@/lib/api'
import api from '@/lib/api'

/**
 * 工作空间顶栏：左侧项目切换器 + 右侧用户菜单。
 *
 * 项目列表懒加载（点开下拉才拉一次）；W1 阶段不做 SWR 缓存，
 * 多次点开会重复请求——可在 W2 优化。
 */
export default function ProjectTopbar() {
  const router = useRouter()
  const currentProject = useAppStore((s) => s.currentProject)
  const currentUser = useAppStore((s) => s.currentUser)

  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [loading, setLoading] = useState(false)

  const projectMenuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false)
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function openProjectMenu() {
    setProjectMenuOpen((v) => !v)
    if (!projects && !loading) {
      setLoading(true)
      try {
        const res = await api.get<{ projects: Project[] }>('/api/projects', {
          suppressErrorToast: true,
        } as any)
        setProjects(res.data.projects || [])
      } catch {
        setProjects([])
      } finally {
        setLoading(false)
      }
    }
  }

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
    } catch {}
    router.push('/login')
  }

  const projectLabel = currentProject?.name ?? currentProject?.slug ?? '加载中…'

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-4 flex-shrink-0">
      {/* 左：项目切换器 */}
      <div ref={projectMenuRef} className="relative">
        <button
          onClick={openProjectMenu}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50"
        >
          <div className="w-6 h-6 rounded bg-blue-100 flex items-center justify-center">
            <i className="fas fa-cube text-xs text-blue-600"></i>
          </div>
          <div className="text-left leading-tight">
            <div className="text-sm font-medium text-gray-900">{projectLabel}</div>
            {currentProject?.slug && (
              <div className="text-[10px] text-gray-400 font-mono">
                {currentProject.slug}
                {currentProject.user_role && ` · ${currentProject.user_role}`}
              </div>
            )}
          </div>
          <i className="fas fa-chevron-down text-[10px] text-gray-400 ml-1"></i>
        </button>

        {projectMenuOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-xs text-gray-500">切换项目</div>
            </div>
            {loading && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                <i className="fas fa-spinner fa-spin mr-1"></i> 加载中…
              </div>
            )}
            {!loading && projects?.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-gray-400">
                你目前没有其他项目
              </div>
            )}
            {!loading && projects && projects.length > 0 && (
              <div className="max-h-72 overflow-y-auto">
                {projects.map((p) => {
                  const active = p.id === currentProject?.id
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setProjectMenuOpen(false)
                        if (!active) {
                          router.push(`/workspace/${p.id}`)
                        }
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between ${
                        active ? 'bg-blue-50' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900 truncate">{p.name}</div>
                        <div className="text-[10px] text-gray-400 font-mono truncate">
                          {p.slug || `id=${p.id}`}
                        </div>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded ml-2 shrink-0">
                        {p.user_role}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="border-t border-gray-100">
              <Link
                href="/workspace"
                onClick={() => setProjectMenuOpen(false)}
                className="block px-3 py-2 text-xs text-blue-600 hover:bg-gray-50"
              >
                <i className="fas fa-list mr-1.5"></i> 查看所有项目
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* 右：用户菜单 */}
      <div ref={userMenuRef} className="relative">
        <button
          onClick={() => setUserMenuOpen((v) => !v)}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50"
        >
          <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-700 font-medium">
            {currentUser?.email?.[0]?.toUpperCase() ?? '?'}
          </div>
          <i className="fas fa-chevron-down text-[10px] text-gray-400"></i>
        </button>

        {userMenuOpen && (
          <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-sm text-gray-900 truncate">{currentUser?.email}</div>
              {currentUser?.is_superadmin && (
                <div className="text-[10px] text-amber-600 mt-0.5">平台超管</div>
              )}
            </div>
            {currentUser?.is_superadmin && (
              <Link
                href="/platform"
                onClick={() => setUserMenuOpen(false)}
                className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <i className="fas fa-shield-alt mr-2"></i> 前往平台控制台
              </Link>
            )}
            <button
              onClick={logout}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <i className="fas fa-sign-out-alt mr-2"></i> 退出登录
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "ProjectTopbar"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/workspace/ProjectTopbar.tsx
git commit -m "feat(w1): add ProjectTopbar with project switcher and user menu"
```

---

## Task 11: Frontend `/workspace/layout.tsx` 最外层（ToastProvider 包裹）

**Files:**
- Create: `frontend-nextjs/app/workspace/layout.tsx`

- [ ] **Step 1: 创建外层 layout**

```tsx
'use client'

import { ToastProvider } from '@/components/Toast'

/**
 * /workspace/* 全部页面共享的最外层 layout。
 *
 * 仅负责 ToastProvider 包裹。token 检查 / 项目元数据加载放在
 * /workspace/[projectId]/layout.tsx 里（因为项目选择页和无项目引导页
 * 不需要解析 projectId）。
 */
export default function WorkspaceRootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <ToastProvider>{children}</ToastProvider>
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-nextjs/app/workspace/layout.tsx
git commit -m "feat(w1): add /workspace/layout.tsx with ToastProvider wrapper"
```

---

## Task 12: Frontend `/workspace/page.tsx` 项目选择页

**Files:**
- Create: `frontend-nextjs/app/workspace/page.tsx`

- [ ] **Step 1: 创建项目选择页**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import type { Project } from '@/lib/store'

/**
 * /workspace 项目选择页。
 *
 * 行为（spec §3.2.1）：
 *   - length === 1 → 直接 router.replace('/workspace/<id>')
 *   - length === 0 → router.replace('/workspace/no-projects')
 *   - 其他 → 列卡片让用户选
 */
export default function WorkspacePickerPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('token')
    if (!token) {
      router.replace('/login')
      return
    }

    api
      .get<{ projects: Project[] }>('/api/projects', { suppressErrorToast: true } as any)
      .then((resp) => {
        const list = resp.data.projects || []
        if (list.length === 0) {
          router.replace('/workspace/no-projects')
        } else if (list.length === 1) {
          router.replace(`/workspace/${list[0].id}`)
        } else {
          setProjects(list)
        }
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err?.message || '加载项目列表失败')
      })
  }, [router])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-exclamation-triangle text-2xl text-red-400 mb-2"></i>
          <p className="text-sm text-gray-700 mb-4">{error}</p>
          <button onClick={() => location.reload()} className="text-sm text-blue-600 hover:underline">
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!projects) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">加载项目列表…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">选择项目</h1>
          <p className="text-sm text-gray-500 mt-1">你可以访问以下 {projects.length} 个项目</p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => router.push(`/workspace/${p.id}`)}
              className="bg-white border border-gray-200 rounded-lg p-4 text-left hover:shadow-sm hover:border-blue-300 transition"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <i className="fas fa-cube text-blue-600"></i>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-mono">
                  {p.user_role}
                </span>
              </div>
              <div className="text-base font-medium text-gray-900 truncate">{p.name}</div>
              <div className="text-xs text-gray-500 font-mono mt-0.5 truncate">
                {p.slug || `id=${p.id}`}
              </div>
              {p.contact_email && (
                <div className="text-xs text-gray-400 mt-2 truncate">
                  <i className="fas fa-envelope mr-1"></i> {p.contact_email}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-nextjs/app/workspace/page.tsx
git commit -m "feat(w1): add /workspace project picker page"
```

---

## Task 13: Frontend `/workspace/no-projects/page.tsx`

**Files:**
- Create: `frontend-nextjs/app/workspace/no-projects/page.tsx`

- [ ] **Step 1: 创建引导页**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { clearAuthToken } from '@/lib/api'

export default function NoProjectsPage() {
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  function logout() {
    clearAuthToken()
    try {
      localStorage.removeItem('current_user')
      localStorage.removeItem('current_tenant')
      localStorage.removeItem('current_project')
    } catch {}
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 mx-auto mb-4 flex items-center justify-center">
          <i className="fas fa-folder-open text-2xl text-gray-400"></i>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">你当前没有可访问的项目</h1>
        <p className="text-sm text-gray-500 mb-6">
          请联系平台管理员为你分配项目，或确认你已被加入正确的工作空间。
        </p>

        {hydrated && currentUser?.is_superadmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-800 mb-4">
            <p className="font-medium mb-1">
              <i className="fas fa-info-circle mr-1"></i> 你是平台超管
            </p>
            <p>可以前往平台控制台创建或管理项目。</p>
            <button
              onClick={() => router.push('/platform')}
              className="mt-2 text-amber-900 hover:underline font-medium"
            >
              前往 /platform →
            </button>
          </div>
        )}

        <button
          onClick={logout}
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          <i className="fas fa-sign-out-alt mr-1"></i> 退出登录
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-nextjs/app/workspace/no-projects/page.tsx
git commit -m "feat(w1): add /workspace/no-projects friendly guide page"
```

---

## Task 14: Frontend `/workspace/[projectId]/layout.tsx`

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/layout.tsx`

- [ ] **Step 1: 创建项目壳 layout**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import api from '@/lib/api'
import { useAppStore, type Project } from '@/lib/store'
import WorkspaceSidebar from '@/components/workspace/WorkspaceSidebar'
import ProjectTopbar from '@/components/workspace/ProjectTopbar'

/**
 * 项目壳 layout（spec §3.2.3）：
 *
 * 1. token 守卫 → 无则跳 /login
 * 2. GET /api/projects/:id → setCurrentProject
 * 3. 失败兜底：
 *    - 403 → 显示"你不是此项目成员"友好页
 *    - 404 → 显示"项目不存在"友好页
 *    - 其他 → 显示通用错误页
 * 4. 渲染壳：ProjectTopbar + WorkspaceSidebar + main
 *
 * projectId 来源始终是 URL params（不从 Zustand），保证 URL 是 source of truth。
 */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const params = useParams<{ projectId: string }>()
  const setCurrentProject = useAppStore((s) => s.setCurrentProject)
  const setCurrentTenant = useAppStore((s) => s.setCurrentTenant)

  const [authorized, setAuthorized] = useState(false)
  const [errorState, setErrorState] = useState<{
    status: number | null
    message: string
  } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const token = localStorage.getItem('token')
    if (!token) {
      router.replace('/login')
      return
    }

    const projectId = parseInt(params.projectId, 10)
    if (isNaN(projectId) || projectId <= 0) {
      router.replace('/workspace')
      return
    }

    // 进入工作空间时清掉旧的 currentTenant，避免与 currentProject 串扰
    setCurrentTenant(null)

    api
      .get<Project>(`/api/projects/${projectId}`, { suppressErrorToast: true } as any)
      .then((resp) => {
        setCurrentProject(resp.data)
        setAuthorized(true)
        setErrorState(null)
      })
      .catch((err) => {
        const status = err?.response?.status ?? null
        const message = err?.response?.data?.error || err?.message || '加载项目失败'
        setErrorState({ status, message })
      })
  }, [params.projectId, router, setCurrentProject, setCurrentTenant])

  if (errorState) {
    const isForbidden = errorState.status === 403
    const isNotFound = errorState.status === 404
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-200 mx-auto mb-4 flex items-center justify-center">
            <i className="fas fa-lock text-2xl text-amber-600"></i>
          </div>
          <h2 className="text-base font-medium text-gray-900 mb-2">
            {isForbidden && '你不是此项目的成员'}
            {isNotFound && '项目不存在'}
            {!isForbidden && !isNotFound && '加载项目失败'}
          </h2>
          <p className="text-sm text-gray-500 mb-6">{errorState.message}</p>
          <button
            onClick={() => router.push('/workspace')}
            className="text-sm text-blue-600 hover:underline"
          >
            ← 返回项目列表
          </button>
        </div>
      </div>
    )
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-2xl text-gray-400 mb-2"></i>
          <p className="text-sm text-gray-500">加载项目…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <ProjectTopbar />
      <div className="flex-1 flex overflow-hidden">
        <WorkspaceSidebar />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "workspace/[projectId]/layout"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/layout.tsx
git commit -m "feat(w1): add project layout with metadata loading + 403/404 fallback"
```

---

## Task 15: Frontend `/workspace/[projectId]/page.tsx` 项目首页

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/page.tsx`

- [ ] **Step 1: 创建项目首页（数据概览，指标先 stub）**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { schemaAPI } from '@/lib/api'

/**
 * 项目首页（数据概览风格，spec §3.2.7）。
 *
 * W1 阶段：4 个指标卡里只有"数据表"是真实数据（schemaAPI.listTables）；
 *          其他三个先 stub 为 '—'，W2 接入真实数据源。
 *          "最近活动"卡片 W1 阶段直接显示 placeholder，W2 接 audit_handlers。
 */
export default function WorkspaceHome() {
  const params = useParams<{ projectId: string }>()
  const currentProject = useAppStore((s) => s.currentProject)
  const [tableCount, setTableCount] = useState<number | string>('—')

  useEffect(() => {
    schemaAPI
      .listTables({ suppressErrorToast: true } as any)
      .then((resp) => {
        const tables = (resp.data as any)?.tables ?? (resp.data as any)?.data ?? []
        setTableCount(Array.isArray(tables) ? tables.length : '—')
      })
      .catch(() => setTableCount('—'))
  }, [params.projectId])

  const base = `/workspace/${params.projectId}`

  const metrics = [
    { label: '数据表', value: tableCount, icon: 'fas fa-table', href: `${base}/database/tables` },
    { label: 'API 端点', value: '—', icon: 'fas fa-cloud', href: `${base}/api` },
    { label: 'RPC 函数', value: '—', icon: 'fas fa-terminal', href: `${base}/rpc` },
    { label: '本月调用量', value: '—', icon: 'fas fa-chart-bar', href: `${base}/monitor` },
  ]

  return (
    <div className="space-y-6 max-w-6xl">
      {/* 项目信息卡 */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              {currentProject?.name ?? params.projectId}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {currentProject?.slug && (
                <span>
                  slug: <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono">{currentProject.slug}</code>
                </span>
              )}
              {currentProject?.status && (
                <span className="ml-3">
                  状态: <span className="text-green-600">{currentProject.status}</span>
                </span>
              )}
              {currentProject?.user_role && (
                <span className="ml-3">
                  你的角色:{' '}
                  <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-mono">
                    {currentProject.user_role}
                  </span>
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* 指标卡片 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {metrics.map((m) => (
          <Link
            key={m.label}
            href={m.href}
            className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-sm hover:border-blue-300 transition"
          >
            <div className="flex items-center gap-2 text-gray-500 text-xs mb-2">
              <i className={`${m.icon} text-blue-500`}></i>
              <span>{m.label}</span>
            </div>
            <div className="text-2xl font-semibold text-gray-900">{m.value}</div>
          </Link>
        ))}
      </section>

      {/* 最近活动（W1 占位，W2 接 audit） */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-medium text-gray-900">最近活动</h2>
          <p className="text-xs text-gray-500 mt-0.5">最近 7 天项目级操作（W2 接入审计日志）</p>
        </div>
        <div className="px-4 py-8 text-center text-sm text-gray-400">
          <i className="fas fa-clock mb-2 text-xl"></i>
          <p>暂无活动数据</p>
        </div>
      </section>

      {/* 快捷入口 */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-900 mb-3">快捷入口</h2>
        <div className="flex flex-wrap gap-2">
          <Link href={`${base}/database/tables`} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
            <i className="fas fa-plus mr-1"></i> 建表
          </Link>
          <Link href={`${base}/rpc`} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
            <i className="fas fa-terminal mr-1"></i> 调用 RPC
          </Link>
          <Link href={`${base}/events/webhooks`} className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
            <i className="fas fa-broadcast-tower mr-1"></i> 配 Webhook
          </Link>
          <Link href={`${base}/api`} className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
            <i className="fas fa-cloud mr-1"></i> 查看 API 文档
          </Link>
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "workspace/[projectId]/page"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 3: 启动前端 + 后端 smoke 验证**

```bash
# 后端
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8

# 前端
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
NEXT_PID=$!
sleep 12

# 简单 ping（不带 token 时 layout 会跳 login，HTML 200 即可）
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/workspace/1

kill $NEXT_PID $BACKEND_PID
```

Expected: 返回 `200`（页面 HTML 渲染成功）。

- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/page.tsx
git commit -m "feat(w1): add project home page with metric cards + recent activity placeholder"
```

---

## Task 16: Frontend Login 跳转改造

**Files:**
- Modify: `frontend-nextjs/app/login/page.tsx:50-52` (`targetAfterLogin` 函数) 和 `93-111` (`handleLogin` 函数)

- [ ] **Step 1: 改 `handleLogin` 的成功分支**

定位 `app/login/page.tsx` 里 `handleLogin` 函数（约 93-111 行）。原结构形如：

```typescript
const handleLogin = async (e) => {
  e.preventDefault()
  // ... loading set ...
  const resp = await axios.post(...)
  const { token, user } = resp.data
  setAuthToken(token)
  setCurrentUser(user)
  router.push(targetAfterLogin(!!user.is_superadmin))
}
```

把它改成（保留原有 try/catch / loading 处理，只改最后几行）：

```typescript
const handleLogin = async (e) => {
  e.preventDefault()
  // ... 原有 loading set / form validation ...
  const resp = await axios.post(...)  // 保持原样
  const { token, user } = resp.data
  setAuthToken(token)
  setCurrentUser(user)

  // 超管：保留现有行为（去 /platform 或 safeNext）
  if (user.is_superadmin) {
    router.push(targetAfterLogin(true))
    return
  }

  // 非超管：按可访问项目数智能分发（spec §3.2.1）
  try {
    const projectsResp = await axios.get('/api/projects', {
      baseURL: API_BASE,  // 保持与 api.ts 一致的 baseURL；如登录页用的是 axios 默认实例可省略
      headers: { Authorization: `Bearer ${token}` },
    })
    const list = projectsResp.data?.projects ?? []
    if (list.length === 0) {
      router.push('/workspace/no-projects')
    } else if (list.length === 1) {
      router.push(`/workspace/${list[0].id}`)
    } else {
      router.push('/workspace')
    }
  } catch {
    // 拉项目失败兜底：丢到 /workspace 选择页（它会再拉一次并兜底）
    router.push('/workspace')
  }
}
```

**注意**：登录页用的是**裸 axios**（不是 `api.ts` 里那个带拦截器的实例），所以要手动拼 `Authorization` 头。`API_BASE` 应来自现有 `import { API_BASE } from '@/lib/api'`——如果该常量尚未导出，则改为直接读取登录用的同款 baseURL（grep 登录页里 `axios.post('/auth/login'...)` 看它用了什么前缀）。

- [ ] **Step 2: `targetAfterLogin` 仅在 is_superadmin 路径上被调用，不用改**

确认 step 1 改完后，`targetAfterLogin` 仍然只在 `is_superadmin === true` 分支被调用。它原有的 `safeNext ?? '/platform'` 逻辑保持不变。

- [ ] **Step 3: TypeScript 编译验证**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -F "login/page.tsx"
echo "===done==="
```

Expected: `===done===` 无报错。

- [ ] **Step 4: 手工 smoke 验证**

```bash
# 同时启动后端 + 前端
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
NEXT_PID=$!
sleep 12
```

浏览器访问 http://localhost:3000/login：
1. 用超管账号登录 → 应跳 `/platform`
2. 用 `test@example.com` 登录 → 应跳到 `/workspace/<projectId>`（或 `/workspace` 选择页，看项目数）

```bash
kill $NEXT_PID $BACKEND_PID
```

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/app/login/page.tsx
git commit -m "feat(w1): smart post-login routing (superadmin→/platform, project member→/workspace)"
```

---

## Task 17: Frontend `/dashboard/layout.tsx` 引导跳转

**Files:**
- Modify: `frontend-nextjs/app/dashboard/layout.tsx:18-45` (useEffect)

- [ ] **Step 1: 在现有超管判断之后追加非超管分发**

定位 `app/dashboard/layout.tsx` 的 useEffect（约 18-45 行）。原结构形如：

```typescript
useEffect(() => {
  const token = localStorage.getItem('token')
  if (!token) {
    router.push('/login')
    return
  }
  const userStr = localStorage.getItem('current_user')
  const tenantStr = localStorage.getItem('current_tenant')
  if (userStr) {
    const user = JSON.parse(userStr)
    if (user.is_superadmin && !tenantStr) {
      router.push('/platform')
      return
    }
  }
  setAuthorized(true)
}, [router])
```

改成（保留超管分支不动，追加非超管分发）：

```typescript
useEffect(() => {
  const token = localStorage.getItem('token')
  if (!token) {
    router.push('/login')
    return
  }
  const userStr = localStorage.getItem('current_user')
  const tenantStr = localStorage.getItem('current_tenant')
  if (!userStr) {
    setAuthorized(true)
    return
  }
  const user = JSON.parse(userStr)

  // 超管：维持现有行为（无 tenant 时去 /platform）
  if (user.is_superadmin && !tenantStr) {
    router.push('/platform')
    return
  }

  // 非超管：去 /workspace 让选择页按项目数分发（spec §3.2.8）
  if (!user.is_superadmin) {
    router.push('/workspace')
    return
  }

  setAuthorized(true)
}, [router])
```

- [ ] **Step 2: 手工 smoke 验证**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
NEXT_PID=$!
sleep 12
```

浏览器：
1. 用超管账号登录 + 进入 `/dashboard` 直链 → 维持现有行为（如果有 tenantStr 就允许；否则 /platform）
2. 用 `test@example.com` 登录 + 进入 `/dashboard` 直链 → 应被跳转到 `/workspace/<projectId>` 或 `/workspace`
3. 整个过程中右下角不应出现红色 toast

```bash
kill $NEXT_PID $BACKEND_PID
```

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/app/dashboard/layout.tsx
git commit -m "feat(w1): non-superadmin /dashboard access redirects to /workspace"
```

---

## Task 18: 全量回归与 W1 出口验收

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量回归测试**

```bash
# 1. Rust 单元 + 构建
cargo build 2>&1 | tail -3
cargo test --bin onebase 2>&1 | tail -15

# 2. Migration 幂等
cargo run --bin migrate_all 2>&1 | tail -5

# 3. 启动后端
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8

# 4. 跑现有集成 + 新增集成
./tests/integration_test.sh > /tmp/int.log 2>&1
INT_EXIT=$?

./tests/m1_workspace_test.sh > /tmp/m1.log 2>&1
M1_EXIT=$?

kill $BACKEND_PID

echo "==="
echo "integration_test.sh exit: $INT_EXIT"
echo "m1_workspace_test.sh exit: $M1_EXIT"
[[ $INT_EXIT -eq 0 && $M1_EXIT -eq 0 ]] && echo "ALL GREEN" || echo "REGRESSION (查看 /tmp/int.log /tmp/m1.log)"
```

Expected: 末行 `ALL GREEN`。

- [ ] **Step 2: 前端构建（W1 阶段下不要求 0 error，仅要求新文件不报错）**

```bash
cd frontend-nextjs
node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 \
  | grep -E "app/workspace|components/workspace|components/shared/ForbiddenPlaceholder" \
  | head -20
echo "===done==="
```

Expected: `===done===` 直出，中间无新增文件的报错。

- [ ] **Step 3: 手工 smoke 全清单（spec §7.2 子集）**

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
NEXT_PID=$!
sleep 12
```

浏览器逐项验证：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 超管登录 → 看到 `/platform` | 正常进入，无红 toast |
| 2 | `test@example.com` 登录（前提：该账号至少有 1 个 tenant） | 直接进 `/workspace/<id>`，**0 红 toast** |
| 3 | 项目首页可见项目名 / slug / user_role 三段信息 | 显示正确 |
| 4 | 左侧栏按 user_role 过滤：viewer 看不见"安全 / 事件 / 设置" | 验证视觉 |
| 5 | 顶栏点项目切换器（仅在多项目用户上有意义） | 拉项目列表，点其他项目能切换 |
| 6 | 顶栏点用户菜单 → 退出登录 | 跳回 `/login` |
| 7 | 已登录普通用户访问 `/dashboard` 直链 | 自动跳转 `/workspace`，无红 toast |
| 8 | 已登录普通用户访问 `/workspace/999999`（不存在 id） | 显示"项目不存在"友好页 + "返回项目列表"按钮 |
| 9 | 已登录普通用户访问别人的 `/workspace/<superadmin-only-id>` | 显示"你不是此项目成员"友好页 |

```bash
kill $NEXT_PID $BACKEND_PID
```

- [ ] **Step 4: W1 出口验收（spec §10）**

逐条 check：

- [ ] `test@example.com` 登录后**直接进入** `/workspace/{shrxhub_test_id}`，**0 条红色 toast**
- [ ] workspace 首页能看到项目名、自己的角色、4 个指标卡片（数据表是真值，其他可为 '—'）
- [ ] 侧边栏 7 个分组按角色正确过滤；点不到的功能不出现
- [ ] 超管登录进入 `/platform` 无回归
- [ ] `tests/m1_workspace_test.sh` 全绿
- [ ] `tests/integration_test.sh` 无回归
- [ ] 手工 smoke step 3 全过

全部 ✅ → W1 完成。

- [ ] **Step 5: 在 spec / plan 索引里标记完成**

```bash
git status  # 应该是 clean（前面任务都已 commit）
```

如果有 README/docs 引用，更新它（grep `2026-05-18-w1-project-workspace`）。

如果一切就绪，给用户写一条总结：

> W1 已完成。下一步可以启动 W2（页面物理迁移）：写 `docs/superpowers/plans/2026-05-XX-w2-page-migration.md`。

---

## Verification Summary

Plan 完成时应满足：

| 验证项 | 命令 | 期望 |
|---|---|---|
| 后端编译 | `cargo build` | `Finished` |
| 后端单测 | `cargo test --bin onebase` | 无回归 |
| Migration 幂等 | `cargo run --bin migrate_all`（跑 2 次） | 第 2 次 skipped ≥ executed，无 FAILED |
| 后端 smoke | `curl http://127.0.0.1:3010/health` | 200 |
| 后端 /api/projects | `curl -H "Authorization: Bearer $TOKEN" /api/projects` | 200，body 有 `"projects":[...]` |
| 现有集成 | `./tests/integration_test.sh` | exit 0 |
| 新增集成 | `./tests/m1_workspace_test.sh` | `PASS≥5 FAIL=0`, exit 0 |
| 前端编译（新文件） | `tsc --noEmit | grep workspace` | 无 workspace 相关报错 |
| `test@example.com` 登录 | 浏览器 | 自动进 `/workspace/[id]`，0 红 toast |
| `/dashboard` 直链 | 浏览器（普通用户登录后） | 自动跳 `/workspace` |
| `/workspace/999999` | 浏览器（普通用户） | "项目不存在"友好页 |

---

## Open Questions / 风险提醒

1. **`test@example.com` 账号 / 密码**：脚本里默认 `Test1234`，如果实际不一样需通过 `USER_PASSWORD=xxx ./tests/m1_workspace_test.sh` 覆盖。如果账号本身不存在，先用 admin 创建一个并加入 `shrxhub_test` 项目。

2. **`schemaAPI.listTables` 在 W1 是否能正确按 currentProject 过滤**：Task 15 首页指标卡的"数据表"数量调用了 `schemaAPI.listTables`。如果该 API 仍依赖 Zustand 的 `currentTenant`（而我们刚把它清空了），这个数会是 0 或报错。如果发现这个问题，W1 阶段把"数据表"也 stub 成 '—'，W2 阶段统一改 schemaAPI 让它接受 `databaseId` 参数（与 RPC 路由统一后的做法一致）。

3. **`useCurrentProjectCapabilities` 在 currentProject 还没加载完时返回 viewer**：会导致首屏短暂闪一下"侧边栏少几项"再展开。如果体感明显，可以在 layout 加载完成前**不渲染** WorkspaceSidebar（用 `if (!authorized) return loader` 已经覆盖）。

4. **`/dashboard/layout` 现有 dashboard 子页面**：W1 阶段普通用户被层层守卫挡在外面，但 `/dashboard/[...child]` 直链如果通过别的路径绕过 layout 仍可能访问到。W2 物理迁移 + `[...slug]` 兜底重定向后才彻底无法访问。

5. **未来 W2 需要 supersede 这个 plan**：W2 plan 启动时，应该把当前保留的 `/dashboard/*` 物理删除并加 `[...slug]` 重定向，那时 Task 17 的 layout 改动会被彻底替代。

---

*本 plan 实现 `docs/superpowers/specs/2026-05-18-project-workspace-w1-w2-design.md` 的 W1 范围。supersedes 旧草稿 `docs/superpowers/plans/2026-05-13-m1-project-workspace.md`（设计部分以新 spec 为准；旧 plan 仅保留作为参考）。*
