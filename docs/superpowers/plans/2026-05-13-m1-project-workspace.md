# M1 项目工作空间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有超管控制台的前提下，为 OneBase 引入「项目（Project）」语义层和工作空间路由，让项目成员可在 `/workspace/<slug>` 下操作仅属于自己项目的资源。

**Architecture:** 在现有 `management.tenants` 表上扩展 2 列（`kind` / `workspace_config`）来承载"项目"语义，**不新建表**。后端新增 `project_models` / `project_handlers` / `project_middleware` 三个模块与现有 `tenant_*` 并列；前端新增 `app/workspace/[projectSlug]/*` 路由层与现有 `app/dashboard/*`（超管台）并列；通过新增 `X-Project-Slug` 请求头贯通前后端的项目上下文。

**Tech Stack:** Rust (axum + sqlx + serde) / TypeScript (Next.js 14 App Router) / PostgreSQL (management schema) / Bash (集成测试)

**Spec 来源:** `docs/superpowers/specs/2026-05-13-platform-evolution-design.md` §2.3 M1 段

**前置假设：**
- 已有 `management.tenants` 表（见 `migrations/003_create_management_schema.sql`）
- 已有 `auth_middleware` / `dynamic_db_middleware`（见 `src/middleware.rs`）
- 已有前端 `app/dashboard/layout.tsx` 和 `app/platform/layout.tsx` 两套 layout
- 后端项目无 Rust 单元测试基础设施；现有测试约定为 `tests/*.sh` shell + curl

**测试策略说明：**
本仓库历史上没有 Rust 单元/集成测试设施（只有 `tests/integration_test.sh`）。本 plan 的 TDD 实践调整为：
1. **纯逻辑代码**（如 enum 序列化、slug 校验、配置默认值）→ 写 Rust `#[cfg(test)] mod tests` 单元测试
2. **HTTP/DB 集成路径** → 在 `tests/m1_workspace_test.sh` 中追加 curl 断言（沿用现有 `tests/integration_test.sh` 风格）
3. **DB migration 本身** → 不写测试，依赖 migration runner 已有的 `MigrationStats` 幂等性 + 手工 smoke

---

## File Structure

| 类别 | 操作 | 文件 | 责任 |
|---|---|---|---|
| Migration | Create | `migrations/014_project_workspace.sql` | tenants 表扩展 + 3 个 RBAC 角色 seed |
| Backend | Create | `src/project_models.rs` | `ProjectKind` enum / `WorkspaceConfig` / `Project` struct |
| Backend | Create | `src/project_handlers.rs` | GET `/api/projects` / GET `/api/projects/:slug` / PATCH `/api/projects/:slug/config` |
| Backend | Create | `src/project_middleware.rs` | 提取 `X-Project-Slug` → `CurrentProjectId` extension |
| Backend | Modify | `src/main.rs` | 注册 3 个新 mod + 3 条新路由 |
| Backend | Modify | `src/lib.rs` | 公开 `project_models` 给二进制以外的访问者（如未来集成测试） |
| Frontend | Create | `frontend-nextjs/app/workspace/[projectSlug]/layout.tsx` | 工作空间布局 + 项目鉴权 |
| Frontend | Create | `frontend-nextjs/app/workspace/[projectSlug]/page.tsx` | 项目首页（占位卡片） |
| Frontend | Create | `frontend-nextjs/components/WorkspaceSidebar.tsx` | 工作空间侧栏 |
| Frontend | Modify | `frontend-nextjs/lib/api.ts` | 注入 `X-Project-Slug` 请求头 |
| Frontend | Modify | `frontend-nextjs/app/dashboard/layout.tsx` | 项目成员（非超管/非 owner）跳转到 workspace |
| Test | Create | `tests/m1_workspace_test.sh` | 端到端 curl 断言 |

---

## Task 1: DB Migration — 扩展 tenants 表 + Seed RBAC 角色

**Files:**
- Create: `migrations/014_project_workspace.sql`
- Modify: `src/bin/migrate_all.rs:10-23` (在 `MIGRATIONS` 数组追加 014 一行)

**重要背景**：本仓库的 migration runner 是 `cargo run --bin migrate_all`（不是 `cargo run --bin migrate`，那个旧的 binary 只跑 001 用户表）。`migrate_all` 的 SQL 列表**硬编码**在 `src/bin/migrate_all.rs:10-23` 的 `MIGRATIONS` 常量数组里——不会自动扫描 `migrations/` 目录。每加一个新 migration 文件都必须在数组里追加一行 `include_str!`。

- [ ] **Step 1: 写 migration SQL**

```sql
-- migrations/014_project_workspace.sql
-- ============================================================
-- M1: 项目工作空间（Project Workspace）
-- ============================================================
-- 在不新建表的前提下，把"租户（Tenant）"扩展出"项目（Project）"语义。
-- 老的 tenant 行通过 kind='legacy_tenant' 标记，新建的项目用 kind='project'。
-- workspace_config 存项目级 UI 偏好（大盘布局、AI 开关等），允许为 NULL。

ALTER TABLE management.tenants
    ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'legacy_tenant',
    ADD COLUMN IF NOT EXISTS workspace_config JSONB;

-- 约束：kind 只能是这两个值
ALTER TABLE management.tenants
    DROP CONSTRAINT IF EXISTS tenants_kind_check;
ALTER TABLE management.tenants
    ADD CONSTRAINT tenants_kind_check
    CHECK (kind IN ('legacy_tenant', 'project'));

CREATE INDEX IF NOT EXISTS idx_tenants_kind ON management.tenants(kind);

-- ============================================================
-- 内置项目角色 seed
-- ============================================================
-- 复用现有 user_tenants.role 字段，新增 3 个项目内置角色。
-- 旧的 owner/admin/member/viewer 仍兼容，新项目推荐用以下三个角色名：
--   project_owner     - 项目所有者（建表/改 RBAC/邀请成员）
--   project_developer - 开发者（读写数据 + 改 schema）
--   project_viewer    - 只读（仅查数据 + 看大盘）
--
-- 这里只是把"角色名"作为约定写进注释；实际的权限映射在 RBAC permissions 表里。
-- 真实的 RBAC 权限模板会在 M4 RBAC 可视化配置阶段落地，本 migration 仅做命名约定。

COMMENT ON COLUMN management.user_tenants.role IS
    'M1 起新建项目推荐使用：project_owner / project_developer / project_viewer。旧值 owner/admin/member/viewer 保留兼容。';

-- ============================================================
-- 历史数据兼容
-- ============================================================
-- 已存在的租户行 kind 默认为 'legacy_tenant'，无需手工修复。
-- 之后通过 PATCH /api/projects/:slug/config 接口可以把 kind 升级为 'project'，
-- 此 migration 不主动修改任何已有 tenant 的 kind，避免影响超管台行为。
```

- [ ] **Step 2: 把 014 注册到 migrate_all.rs**

打开 `src/bin/migrate_all.rs`，在 `MIGRATIONS` 数组末尾（第 22 行 "012 jwt sessions" 之后、第 22 行尾部注释 `// 013_rls_helpers ...` 之前）追加一行：

```rust
    ("014 project workspace",    include_str!("../../migrations/014_project_workspace.sql")),
```

最终数组应像这样：

```rust
const MIGRATIONS: &[(&str, &str)] = &[
    ("001 users table",          include_str!("../../migrations/001_create_users_table.sql")),
    ("003 management schema",    include_str!("../../migrations/003_create_management_schema.sql")),
    ("004 superadmin role",      include_str!("../../migrations/004_add_superadmin_role.sql")),
    ("005 RBAC tables",          include_str!("../../migrations/005_rbac_tables.sql")),
    ("006 SSO providers",        include_str!("../../migrations/006_sso_providers.sql")),
    ("007 read replicas",        include_str!("../../migrations/007_read_replicas.sql")),
    ("008 webhooks",             include_str!("../../migrations/008_webhooks.sql")),
    ("009 audit logs",           include_str!("../../migrations/009_audit_logs.sql")),
    ("010 gateway config",       include_str!("../../migrations/010_gateway_config.sql")),
    ("011 default permissions",  include_str!("../../migrations/011_seed_default_permissions.sql")),
    ("012 jwt sessions",         include_str!("../../migrations/012_jwt_sessions.sql")),
    ("014 project workspace",    include_str!("../../migrations/014_project_workspace.sql")),
    // 013_rls_helpers 是给业务库（tenant database）跑的，不在管理库 migrate_all 范围内。
];
```

- [ ] **Step 3: 跑 migration 并验证**

Run:
```bash
cargo run --bin migrate_all
```

Expected output 末尾应包含一行类似：
```
  [014 project workspace] OK (5 executed, 0 skipped)
```
（首跑 ok=4-5，重跑 ok 数会下降而 skipped 数上升；总之 `errors=0`）

随后用 `psql` 验证：
```bash
psql "$DATABASE_URL" -c "\d management.tenants" | grep -E "kind|workspace_config"
```

Expected 输出包含：
```
 kind             | character varying(32)       |           | not null | 'legacy_tenant'::character varying
 workspace_config | jsonb                       |           |          |
```

- [ ] **Step 4: 幂等性验证**

再跑一次 migration，确认良性：
```bash
cargo run --bin migrate_all
```
Expected：末行 `所有迁移执行完毕！`，没有 `迁移过程中出现 N 处错误` 信息；`014` 那一行应该是 `OK (0 executed, 5 skipped)` 或类似，**没有任何 `FAILED`**。

- [ ] **Step 5: Commit**

```bash
git add migrations/014_project_workspace.sql src/bin/migrate_all.rs
git commit -m "feat#t10000001: 添加 management.tenants 的 kind 与 workspace_config 列以及项目角色约定"
```

---

## Task 2: Backend Model — `src/project_models.rs`

**Files:**
- Create: `src/project_models.rs`

- [ ] **Step 1: 写失败的单元测试**

先创建文件框架（仅 mod tests，让测试先失败）：

```rust
// src/project_models.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_kind_serializes_as_lowercase() {
        let s = serde_json::to_string(&ProjectKind::Project).unwrap();
        assert_eq!(s, "\"project\"");
        let s2 = serde_json::to_string(&ProjectKind::LegacyTenant).unwrap();
        assert_eq!(s2, "\"legacy_tenant\"");
    }

    #[test]
    fn workspace_config_default_is_empty_object() {
        let cfg = WorkspaceConfig::default();
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.is_object());
        assert_eq!(json.as_object().unwrap().len(), 0);
    }

    #[test]
    fn project_slug_validation_rejects_invalid() {
        assert!(validate_project_slug("good-name").is_ok());
        assert!(validate_project_slug("good_123").is_ok());
        assert!(validate_project_slug("a").is_err()); // 过短
        assert!(validate_project_slug("Bad Name").is_err()); // 含空格
        assert!(validate_project_slug("UPPER").is_err()); // 大写
        assert!(validate_project_slug("with/slash").is_err()); // 含斜杠
    }
}
```

- [ ] **Step 2: 跑测试验证 fail**

需要先在 `src/main.rs` 加 `mod project_models;`（只为编译，详细注册留给 Task 5）：

```bash
# 临时手工 patch main.rs（之后 Task 5 会正式加）
# 或者直接 cargo check 看到 missing module 错误也算 fail
cargo test --bin onebase project_models 2>&1 | tail -20
```
Expected: `error[E0432]: unresolved import` 或 `not found in this scope`，因为还没写实现。

- [ ] **Step 3: 写实现**

把整个文件填满（替换 step 1 的占位）：

```rust
// src/project_models.rs

//! 项目（Project）域模型
//!
//! 与 `tenant_models` 的关系：
//! - `Project` 对应 `management.tenants` 行（同一张表），但只有 `kind='project'` 的子集
//! - `Tenant` 仍代表全集（既包括 legacy_tenant 也包括 project），保持现有兼容
//! - 业务代码访问"工作空间"语义时使用 `Project`；访问连接池等基础设施时仍可用 `Tenant`

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 项目类型（来自 `management.tenants.kind`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    LegacyTenant,
    Project,
}

impl ProjectKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectKind::LegacyTenant => "legacy_tenant",
            ProjectKind::Project => "project",
        }
    }
}

/// 项目工作空间 UI 偏好（存 `tenants.workspace_config` JSONB 列）
///
/// 默认空对象 `{}`；后续按需扩展字段（dashboard 布局 / AI 开关 / 通知偏好）。
/// 反序列化容错：未知字段忽略，所有字段可选。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard_layout: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_enabled: Option<bool>,
}

/// 项目实体（来自 `management.tenants` 行的 project 子集）
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub slug: String,
    pub status: String,
    pub kind: String, // 'legacy_tenant' | 'project'
    pub contact_email: Option<String>,
    pub workspace_config: Option<sqlx::types::Json<WorkspaceConfig>>,
}

/// 校验项目 slug：
/// - 长度 2-50
/// - 仅 a-z, 0-9, '-', '_'
/// - 不能以 '-' 或 '_' 开头/结尾
///
/// 注：M1 没有创建项目的入口（需通过 SQL 或 admin 接口手工创建），
/// 本函数将在 **M2 自助开通向导** 的 `POST /api/projects/provision` 端点首次被调用。
/// 在 M1 阶段提前定义并加单元测试，是为了 M2 落地时无需返工。
pub fn validate_project_slug(slug: &str) -> Result<(), String> {
    if slug.len() < 2 || slug.len() > 50 {
        return Err(format!("slug 长度必须在 2-50 之间（当前 {}）", slug.len()));
    }
    let bytes = slug.as_bytes();
    if bytes[0] == b'-' || bytes[0] == b'_' || bytes[bytes.len() - 1] == b'-' || bytes[bytes.len() - 1] == b'_' {
        return Err("slug 不能以 '-' 或 '_' 开头/结尾".to_string());
    }
    for &b in bytes {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_';
        if !ok {
            return Err(format!("slug 仅允许 a-z / 0-9 / - / _（出现非法字符 {:?}）", b as char));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_kind_serializes_as_lowercase() {
        let s = serde_json::to_string(&ProjectKind::Project).unwrap();
        assert_eq!(s, "\"project\"");
        let s2 = serde_json::to_string(&ProjectKind::LegacyTenant).unwrap();
        assert_eq!(s2, "\"legacy_tenant\"");
    }

    #[test]
    fn workspace_config_default_is_empty_object() {
        let cfg = WorkspaceConfig::default();
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.is_object());
        assert_eq!(json.as_object().unwrap().len(), 0);
    }

    #[test]
    fn project_slug_validation_rejects_invalid() {
        assert!(validate_project_slug("good-name").is_ok());
        assert!(validate_project_slug("good_123").is_ok());
        assert!(validate_project_slug("a").is_err());
        assert!(validate_project_slug("Bad Name").is_err());
        assert!(validate_project_slug("UPPER").is_err());
        assert!(validate_project_slug("with/slash").is_err());
    }
}
```

- [ ] **Step 4: 跑测试验证 pass**

需要在 `src/main.rs` 顶部 mod 声明列表加上 `mod project_models;`（如果 Task 5 还没做，就先临时加这一行）。

Run:
```bash
cargo test --bin onebase project_models -- --nocapture
```
Expected:
```
running 3 tests
test project_models::tests::project_kind_serializes_as_lowercase ... ok
test project_models::tests::workspace_config_default_is_empty_object ... ok
test project_models::tests::project_slug_validation_rejects_invalid ... ok

test result: ok. 3 passed
```

- [ ] **Step 5: Commit**

```bash
git add src/project_models.rs
git commit -m "feat(m1): add Project / ProjectKind / WorkspaceConfig models with slug validation"
```

---

## Task 3: Backend Middleware — `src/project_middleware.rs`

**Files:**
- Create: `src/project_middleware.rs`

- [ ] **Step 1: 写失败的单元测试**

```rust
// src/project_middleware.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_project_extracts_id() {
        let cp = CurrentProject { id: 42, slug: "demo".to_string() };
        assert_eq!(cp.id, 42);
        assert_eq!(cp.slug, "demo");
    }
}
```

- [ ] **Step 2: 跑测试验证 fail**

```bash
cargo test --bin onebase project_middleware 2>&1 | tail -5
```
Expected: 编译错误（`CurrentProject` 未定义）。

- [ ] **Step 3: 写实现**

```rust
// src/project_middleware.rs

//! 项目（Project）上下文中间件
//!
//! 解析顺序：
//! 1. 优先取请求头 `X-Project-Slug`（前端 axios 拦截器注入）
//! 2. 若未携带，则尝试从 URL 路径 `/api/projects/:slug/...` 中提取（M1 暂未启用，Task 6 留口）
//!
//! 解析成功后：
//! - 在 PG 里查 `management.tenants` 校验 slug → tenant_id
//! - 若是非超管，校验 `user_tenants` 中 user_id × tenant_id × is_active=true
//! - 把 `CurrentProject { id, slug }` 注入 request extensions
//!
//! 失败行为：
//! - 没有 X-Project-Slug → 不阻断（Pass through）；下游想用 project 上下文的 handler
//!   自己用 `req.extensions().get::<CurrentProject>()` 判 None
//! - 有 X-Project-Slug 但 slug 不存在 / 用户无权访问 → 403 Forbidden

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::AppError;

/// 当前请求选中的项目，通过 Extension 暴露给下游 handler。
#[derive(Clone, Debug)]
pub struct CurrentProject {
    pub id: i32,
    pub slug: String,
}

pub async fn project_context_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let slug_opt: Option<String> = req
        .headers()
        .get("X-Project-Slug")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    let Some(slug) = slug_opt else {
        return Ok(next.run(req).await);
    };

    let row = sqlx::query(
        "SELECT id FROM management.tenants WHERE slug = $1 AND status = 'active'",
    )
    .bind(&slug)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询项目失败: {}", e)))?;

    let tenant_id: i32 = match row {
        Some(r) => r.get("id"),
        None => return Err(AppError::Forbidden(format!("项目 {} 不存在或未启用", slug))),
    };

    if let Some(claims) = req.extensions().get::<Claims>() {
        if !claims.is_superadmin {
            let has_access: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM management.user_tenants WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
            )
            .bind(claims.sub)
            .bind(tenant_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(false);

            if !has_access {
                return Err(AppError::Forbidden(format!(
                    "用户无权访问项目 {}",
                    slug
                )));
            }
        }
    }

    req.extensions_mut().insert(CurrentProject {
        id: tenant_id,
        slug,
    });

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_project_extracts_id() {
        let cp = CurrentProject { id: 42, slug: "demo".to_string() };
        assert_eq!(cp.id, 42);
        assert_eq!(cp.slug, "demo");
    }
}
```

- [ ] **Step 4: 跑测试验证 pass**

需要先在 `src/main.rs` 临时加 `mod project_middleware;`（Task 5 正式加）。

```bash
cargo test --bin onebase project_middleware -- --nocapture
```
Expected:
```
test project_middleware::tests::current_project_extracts_id ... ok
test result: ok. 1 passed
```

- [ ] **Step 5: Commit**

```bash
git add src/project_middleware.rs
git commit -m "feat(m1): add project_context_middleware extracting CurrentProject from X-Project-Slug"
```

---

## Task 4: Backend Handlers — `src/project_handlers.rs`

**Files:**
- Create: `src/project_handlers.rs`

- [ ] **Step 1: 写实现**

（DB 集成路径不写 Rust 单测，留给 Task 8 的 shell 集成测试覆盖。）

```rust
// src/project_handlers.rs

//! 项目（Project）查询与配置 handler
//!
//! 路由：
//!   GET   /api/projects                 - 列出当前用户可见项目（kind='project'）
//!   GET   /api/projects/:slug           - 单个项目详情（含 workspace_config）
//!   PATCH /api/projects/:slug/config    - 更新项目 workspace_config（仅项目 owner / 超管）
//!
//! 与 tenant_handlers 的边界：
//!   - tenant_handlers 仍负责"全部 tenant"的连接管理（含 legacy_tenant）
//!   - 本 handler 仅返回 kind='project' 的子集，并暴露 workspace_config 字段

use axum::{extract::{Path, State}, Json};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::AppError;
use crate::project_models::{Project, ProjectKind, WorkspaceConfig};

/// GET /api/projects
pub async fn list_projects(
    State(pool): State<PgPool>,
    claims: axum::Extension<Claims>,
) -> Result<Json<serde_json::Value>, AppError> {
    let project_kind = ProjectKind::Project.as_str();
    let rows = if claims.is_superadmin {
        sqlx::query(
            "SELECT id, name, slug, status, kind, contact_email, workspace_config
             FROM management.tenants
             WHERE kind = $1
             ORDER BY id DESC",
        )
        .bind(project_kind)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            "SELECT t.id, t.name, t.slug, t.status, t.kind, t.contact_email, t.workspace_config
             FROM management.tenants t
             JOIN management.user_tenants ut ON ut.tenant_id = t.id AND ut.is_active = true
             WHERE t.kind = $1 AND ut.user_id = $2
             ORDER BY t.id DESC",
        )
        .bind(project_kind)
        .bind(claims.sub)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("查询项目列表失败: {}", e)))?;

    let projects: Vec<serde_json::Value> = rows.iter().map(|r| {
        json!({
            "id": r.get::<i32, _>("id"),
            "name": r.get::<String, _>("name"),
            "slug": r.get::<String, _>("slug"),
            "status": r.get::<String, _>("status"),
            "kind": r.get::<String, _>("kind"),
            "contact_email": r.try_get::<Option<String>, _>("contact_email").unwrap_or(None),
            "workspace_config": r.try_get::<Option<sqlx::types::Json<WorkspaceConfig>>, _>("workspace_config")
                .ok().flatten().map(|j| j.0),
        })
    }).collect();

    Ok(Json(json!({ "projects": projects })))
}

/// GET /api/projects/:slug
pub async fn get_project(
    State(pool): State<PgPool>,
    claims: axum::Extension<Claims>,
    Path(slug): Path<String>,
) -> Result<Json<Project>, AppError> {
    let row: Project = sqlx::query_as::<_, Project>(
        "SELECT id, name, slug, status, kind, contact_email, workspace_config
         FROM management.tenants
         WHERE slug = $1 AND kind = $2 AND status = 'active'",
    )
    .bind(&slug)
    .bind(ProjectKind::Project.as_str())
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询项目失败: {}", e)))?
    .ok_or_else(|| AppError::NotFound(format!("项目 {} 不存在", slug)))?;

    if !claims.is_superadmin {
        let has_access: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM management.user_tenants WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
        )
        .bind(claims.sub)
        .bind(row.id)
        .fetch_one(&pool)
        .await
        .unwrap_or(false);

        if !has_access {
            return Err(AppError::Forbidden(format!("用户无权访问项目 {}", slug)));
        }
    }

    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfigRequest {
    pub workspace_config: WorkspaceConfig,
}

/// PATCH /api/projects/:slug/config
pub async fn update_project_config(
    State(pool): State<PgPool>,
    claims: axum::Extension<Claims>,
    Path(slug): Path<String>,
    Json(req): Json<UpdateConfigRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let tenant_id: i32 = sqlx::query_scalar(
        "SELECT id FROM management.tenants WHERE slug = $1 AND kind = $2",
    )
    .bind(&slug)
    .bind(ProjectKind::Project.as_str())
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询项目失败: {}", e)))?
    .ok_or_else(|| AppError::NotFound(format!("项目 {} 不存在", slug)))?;

    if !claims.is_superadmin {
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM management.user_tenants
             WHERE user_id = $1 AND tenant_id = $2 AND is_active = true",
        )
        .bind(claims.sub)
        .bind(tenant_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("查询用户角色失败: {}", e)))?;

        let allowed = matches!(role.as_deref(), Some("project_owner") | Some("owner"));
        if !allowed {
            return Err(AppError::Forbidden(
                "仅项目 owner 可修改 workspace_config".to_string(),
            ));
        }
    }

    let cfg_json = serde_json::to_value(&req.workspace_config)
        .map_err(|e| AppError::Internal(format!("序列化 workspace_config 失败: {}", e)))?;

    sqlx::query("UPDATE management.tenants SET workspace_config = $1 WHERE id = $2")
        .bind(&cfg_json)
        .bind(tenant_id)
        .execute(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("更新 workspace_config 失败: {}", e)))?;

    Ok((StatusCode::OK, Json(json!({ "ok": true, "slug": slug }))))
}
```

- [ ] **Step 2: 让代码编译过**

需要 Task 5 把 `mod project_handlers;` 加到 `main.rs`。如果是顺序执行就先把这行加进去，让 cargo check 过。

Run:
```bash
cargo check 2>&1 | tail -15
```
Expected: `Finished` 无错误。如果有 `AppError::NotFound` 不存在的错误，看 `src/error.rs` 用现有的等价 variant（如 `NotFound`）。

- [ ] **Step 3: Commit**

```bash
git add src/project_handlers.rs
git commit -m "feat(m1): add project_handlers (list/get/update_config) with RBAC"
```

---

## Task 5: 在 `src/main.rs` 注册新 mod 与路由

**Files:**
- Modify: `src/main.rs:1-42` (mod 声明区) 和路由注册区（grep `auth_middleware` 附近的 `Router::new()`）

- [ ] **Step 1: 加 mod 声明**

在 `src/main.rs` 的 mod 声明区（第 1-42 行附近，**按字母序**插入）：

```rust
mod project_handlers;
mod project_middleware;
mod project_models;
```

具体插入位置：紧跟 `mod permission_cache;` 之后、`mod query_cache;` 之前（按已有的"基本字母序"约定）。

- [ ] **Step 2: 注册路由**

在 `src/main.rs` 中找到注册受保护路由的 `Router::new()`（grep `/auth/me`，附近就是受 `auth_middleware` 保护的路由组）。在 `/auth/change-password` 之后加 3 条新路由：

```rust
        .route("/api/projects", get(project_handlers::list_projects))
        .route("/api/projects/:slug", get(project_handlers::get_project))
        .route("/api/projects/:slug/config", patch(project_handlers::update_project_config))
```

- [ ] **Step 3: 注册 project_context_middleware（可选，M1 不强制启用）**

M1 阶段先**不挂载** `project_context_middleware` 到全局——让 handler 自己按需读取 `X-Project-Slug` 头即可。理由：这一层保留为 M2/M3 真正需要"项目隔离的资源访问"时再启用，避免 M1 阶段就影响所有现有路由。

留下文档注释：在 `src/main.rs` 路由注册区的开头加一行注释：

```rust
        // M1 阶段: project_middleware::project_context_middleware 已实现但未挂载，
        // 留待 M2 / M3 把"项目隔离资源访问"路由加入时再以 .layer 挂载
```

- [ ] **Step 4: 验证编译 + 跑所有单测**

```bash
cargo build 2>&1 | tail -10
cargo test --bin onebase 2>&1 | tail -15
```
Expected: build `Finished`；test 至少包含我们刚加的 4 个测试都 ok（其它已有测试不应回归）。

- [ ] **Step 5: 启动服务 smoke 校验**

```bash
cargo run --bin onebase 2>&1 | head -30 &
sleep 5
curl -sS http://127.0.0.1:3010/health
kill %1
```
Expected: `health` 返回 200；启动日志无 panic。

- [ ] **Step 6: Commit**

```bash
git add src/main.rs
git commit -m "feat(m1): register project_handlers routes and project_models / project_middleware mods"
```

---

## Task 6: Frontend — 工作空间 Layout 与首页

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectSlug]/layout.tsx`
- Create: `frontend-nextjs/app/workspace/[projectSlug]/page.tsx`
- Create: `frontend-nextjs/components/WorkspaceSidebar.tsx`

- [ ] **Step 1: 写 WorkspaceSidebar 组件**

```tsx
// frontend-nextjs/components/WorkspaceSidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'

const navItems = [
  { label: '项目首页', href: '', icon: 'fas fa-home' },
  { label: '数据表（M3 占位）', href: '/tables', icon: 'fas fa-table' },
  { label: '权限配置（M4 占位）', href: '/rbac', icon: 'fas fa-user-shield' },
  { label: '订阅事件（M5 占位）', href: '/webhooks', icon: 'fas fa-bell' },
  { label: '监控大盘（M6 占位）', href: '/monitor', icon: 'fas fa-chart-line' },
]

export default function WorkspaceSidebar() {
  const pathname = usePathname()
  const params = useParams<{ projectSlug: string }>()
  const base = `/workspace/${params.projectSlug}`

  return (
    <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-4 border-b border-gray-200">
        <div className="text-xs text-gray-500">项目工作空间</div>
        <div className="text-base font-semibold text-gray-900 truncate">
          {params.projectSlug}
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {navItems.map((it) => {
          const href = `${base}${it.href}`
          const active = pathname === href
          return (
            <Link
              key={it.href}
              href={href}
              className={`flex items-center gap-3 px-4 py-2 text-sm ${
                active
                  ? 'bg-blue-50 text-blue-600 border-l-2 border-blue-500'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <i className={`${it.icon} w-4 text-center`}></i>
              <span className="truncate">{it.label}</span>
            </Link>
          )
        })}
      </nav>
      <div className="px-4 py-3 border-t border-gray-200">
        <Link
          href="/dashboard"
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          ← 返回旧版控制台
        </Link>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: 写 workspace layout**

```tsx
// frontend-nextjs/app/workspace/[projectSlug]/layout.tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ToastProvider } from '@/components/Toast'
import WorkspaceSidebar from '@/components/WorkspaceSidebar'
import api from '@/lib/api'

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const params = useParams<{ projectSlug: string }>()
  const [authorized, setAuthorized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    localStorage.setItem('current_project_slug', params.projectSlug)

    api
      .get(`/api/projects/${params.projectSlug}`)
      .then((resp) => {
        localStorage.setItem('current_project', JSON.stringify(resp.data))
        setAuthorized(true)
      })
      .catch((err) => {
        const msg =
          err?.response?.data?.error || err?.message || '加载项目失败'
        setError(msg)
      })
  }, [router, params.projectSlug])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-exclamation-triangle text-2xl text-red-400 mb-2"></i>
          <p className="text-sm text-gray-700">{error}</p>
          <button
            onClick={() => router.push('/dashboard')}
            className="mt-4 text-sm text-blue-600 hover:underline"
          >
            返回旧版控制台
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
          <p className="text-sm text-gray-500">加载项目中...</p>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div className="min-h-screen flex bg-gray-50">
        <WorkspaceSidebar />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </ToastProvider>
  )
}
```

- [ ] **Step 3: 写 workspace 首页**

```tsx
// frontend-nextjs/app/workspace/[projectSlug]/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

interface ProjectInfo {
  id: number
  name: string
  slug: string
  status: string
  kind: string
  contact_email?: string
}

export default function WorkspaceHome() {
  const params = useParams<{ projectSlug: string }>()
  const [project, setProject] = useState<ProjectInfo | null>(null)

  useEffect(() => {
    const raw = localStorage.getItem('current_project')
    if (raw) {
      try {
        setProject(JSON.parse(raw))
      } catch {}
    }
  }, [params.projectSlug])

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">
          {project?.name || params.projectSlug}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          项目 slug: <code className="px-1.5 py-0.5 bg-gray-100 rounded">{params.projectSlug}</code>
          {project?.status && (
            <span className="ml-3">
              状态: <span className="text-green-600">{project.status}</span>
            </span>
          )}
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { title: '数据表', desc: 'M3 阶段加入：可视化建表与编辑', icon: 'fas fa-table' },
          { title: '权限配置', desc: 'M4 阶段加入：角色与行/列级权限', icon: 'fas fa-user-shield' },
          { title: '订阅事件', desc: 'M5 阶段加入：Webhook / Realtime', icon: 'fas fa-bell' },
          { title: '监控大盘', desc: 'M6 阶段加入：QPS / 慢查询 / 审计', icon: 'fas fa-chart-line' },
          { title: 'AI 助手', desc: 'M7 阶段加入：NL2SQL / 慢查询诊断', icon: 'fas fa-robot' },
          { title: '项目设置', desc: 'workspace_config / 成员管理（M1 已就绪）', icon: 'fas fa-cog' },
        ].map((c) => (
          <div
            key={c.title}
            className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-sm transition"
          >
            <div className="flex items-center gap-3 mb-2">
              <i className={`${c.icon} text-blue-600`}></i>
              <h2 className="text-sm font-medium text-gray-900">{c.title}</h2>
            </div>
            <p className="text-xs text-gray-500">{c.desc}</p>
          </div>
        ))}
      </section>
    </div>
  )
}
```

- [ ] **Step 4: 跑前端开发服务器 smoke 验证**

```bash
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
sleep 10
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/workspace/demo
kill %1
```
Expected: 返回 `200`（即使后端没数据也会进入 layout 的 loading 状态 → 200）。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/app/workspace frontend-nextjs/components/WorkspaceSidebar.tsx
git commit -m "feat(m1): add /workspace/[projectSlug] layout, home page, and WorkspaceSidebar"
```

---

## Task 7: Frontend — `lib/api.ts` 注入 X-Project-Slug 请求头

**Files:**
- Modify: `frontend-nextjs/lib/api.ts:43-71` (请求拦截器内的 if 块)

- [ ] **Step 1: 在 axios 请求拦截器追加 X-Project-Slug 注入**

定位 `lib/api.ts:53-64` 现有的 `X-Database-Id` 注入逻辑，在它后面紧邻插入：

```typescript
      const projectSlug = localStorage.getItem('current_project_slug')
      if (projectSlug) {
        config.headers['X-Project-Slug'] = projectSlug
      }
```

- [ ] **Step 2: 启动前端 + 后端，端到端验证请求头**

```bash
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
sleep 10

# 在另一个 terminal 启动后端，开 trace 日志
RUST_LOG=info,onebase=trace cargo run --bin onebase 2>&1 | tee /tmp/backend.log &
sleep 5

# 浏览器访问 http://localhost:3000/workspace/demo（先在 localStorage 设 token）
# 检查后端日志中应出现 "X-Project-Slug: demo" 相关条目
grep -i "X-Project-Slug" /tmp/backend.log | head -5
```
Expected：`grep` 至少有一条命中。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/lib/api.ts
git commit -m "feat(m1): inject X-Project-Slug request header from current_project_slug localStorage"
```

---

## Task 8: 端到端 Shell 集成测试

**Files:**
- Create: `tests/m1_workspace_test.sh`

- [ ] **Step 1: 写测试脚本**

```bash
#!/usr/bin/env bash
# ============================================================
# M1 项目工作空间端到端集成测试
#
# 跑法：
#   ./tests/m1_workspace_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_test.sh
#
# 前置：服务已启动；admin / Admin123 可登录；
#       至少 1 个 kind='project' 的项目存在（脚本会用 SQL 直接 seed 一个 demo 项目）。
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/onebase}"

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

# Seed: 把示例公司A 升级为 kind='project'
log "Seed demo project (slug=company-a → kind=project)"
psql "$DATABASE_URL" -c "UPDATE management.tenants SET kind='project' WHERE slug='company-a';" >/dev/null

# Login admin
log "Admin login"
TOKEN=$(curl -sS -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | grep -oE '"token":"[^"]+"' | cut -d'"' -f4)
[[ -z "$TOKEN" ]] && { echo "FATAL: 未拿到 admin token"; exit 2; }

# Test 1: GET /api/projects 应包含 company-a
log "Test 1: GET /api/projects"
BODY=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API_BASE/api/projects")
echo "$BODY" | grep -q '"slug":"company-a"' && r=ok || r=miss
assert_eq "list_projects 包含 company-a" "ok" "$r"

# Test 2: GET /api/projects/company-a 详情
log "Test 2: GET /api/projects/company-a"
STATUS=$(curl -sS -o /tmp/m1_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$API_BASE/api/projects/company-a")
assert_eq "get_project status" "200" "$STATUS"
grep -q '"kind":"project"' /tmp/m1_get.json && r=ok || r=miss
assert_eq "get_project kind=project" "ok" "$r"

# Test 3: GET 不存在的项目应 404
log "Test 3: GET /api/projects/__no_such__"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$API_BASE/api/projects/__no_such__")
assert_eq "get_project 404" "404" "$STATUS"

# Test 4: PATCH /api/projects/company-a/config（超管可改）
log "Test 4: PATCH config 更新 ai_enabled=true"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"workspace_config":{"ai_enabled":true}}' \
    "$API_BASE/api/projects/company-a/config")
assert_eq "patch config status" "200" "$STATUS"

# Test 5: PATCH 后 GET 应能看到 ai_enabled=true
log "Test 5: GET 验证 workspace_config.ai_enabled"
curl -sS -H "Authorization: Bearer $TOKEN" \
    "$API_BASE/api/projects/company-a" \
    | grep -q '"ai_enabled":true' && r=ok || r=miss
assert_eq "config persisted" "ok" "$r"

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
sleep 8
./tests/m1_workspace_test.sh
EXIT=$?
kill %1
exit $EXIT
```
Expected: `PASS=5  FAIL=0`，退出码 0。

- [ ] **Step 4: 现有 integration_test.sh 回归**

跑现有 shell 测试确保没回归现有 RBAC / 多租户行为：

```bash
cargo run --bin onebase > /tmp/backend.log 2>&1 &
sleep 8
./tests/integration_test.sh
EXIT=$?
kill %1
exit $EXIT
```
Expected: 退出码 0；FAIL=0。

- [ ] **Step 5: Commit**

```bash
git add tests/m1_workspace_test.sh
git commit -m "test(m1): end-to-end shell test for /api/projects endpoints"
```

---

## Task 9: 现有 dashboard layout 项目成员路由调整

**Files:**
- Modify: `frontend-nextjs/app/dashboard/layout.tsx:18-45` (useEffect 内的角色判断)

- [ ] **Step 1: 加"项目成员自动跳转 workspace"逻辑**

定位 `app/dashboard/layout.tsx:30-42` 现有 `userStr` 解析块，在超管判断之后插入项目成员引导：

```typescript
      const user = JSON.parse(userStr)

      if (user.is_superadmin && !tenantStr) {
        router.push('/platform')
        return
      }

      if (!user.is_superadmin) {
        const projectSlug = localStorage.getItem('current_project_slug')
        if (projectSlug) {
          router.push(`/workspace/${projectSlug}`)
          return
        }
      }
```

效果：项目成员（非超管）只要 localStorage 里有 `current_project_slug`，就直接进入新版工作空间；没有则保持现状（兼容老流程）。

- [ ] **Step 2: 手工 smoke 验证**

```bash
cd frontend-nextjs
npm run dev > /tmp/next-dev.log 2>&1 &
sleep 10
```

浏览器：
1. 用超管账号登录 → 应进入 `/platform`（无回归）
2. 用 alice 登录（普通用户）→ localStorage 无 `current_project_slug` → 进入 `/dashboard`（无回归）
3. 浏览器手工设 `localStorage.setItem('current_project_slug', 'company-a')` 后刷新 `/dashboard` → 应跳转到 `/workspace/company-a`

```bash
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/app/dashboard/layout.tsx
git commit -m "feat(m1): redirect non-superadmin users with current_project_slug to workspace"
```

---

## Task 10: 文档与最终验证

**Files:**
- Modify: `README.md`（追加 M1 章节）— 仅在 README 已有"功能清单"或类似目录时追加；否则跳过

- [ ] **Step 1: 在 README 末尾追加 M1 章节（仅在已有类似结构时）**

如 README 已有"## 功能模块"或类似清单，追加：

```markdown
### M1 项目工作空间（v1，已上线）

- 后端：`/api/projects` `/api/projects/:slug` `/api/projects/:slug/config` 三个端点
- 前端：`/workspace/[projectSlug]` 路由 + WorkspaceSidebar；非超管成员自动跳转
- DB：`management.tenants` 新增 `kind` 与 `workspace_config` 列；旧数据兼容
- 测试：`tests/m1_workspace_test.sh`
```

如 README 没有可挂的小节，跳过本步骤，直接进入最终验证。

- [ ] **Step 2: 全量回归（关键）**

依次跑：
```bash
cargo build 2>&1 | tail -3
cargo test --bin onebase 2>&1 | tail -10

cargo run --bin onebase > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 8

./tests/integration_test.sh
INT_EXIT=$?

./tests/m1_workspace_test.sh
M1_EXIT=$?

kill $BACKEND_PID

echo "integration_test.sh exit: $INT_EXIT"
echo "m1_workspace_test.sh exit: $M1_EXIT"
[[ $INT_EXIT -eq 0 && $M1_EXIT -eq 0 ]] && echo "ALL GREEN" || echo "REGRESSION"
```
Expected: 末行打印 `ALL GREEN`。

- [ ] **Step 3: M1 出口验收**

按 spec §3.1 「M0 出口标准」（实质等同于 M1）人工核对：

- [x] 现有客户 / 试点客户名单与 PG 版本范围 — 不阻塞 M1
- [x] 超管控制台 `/platform` 无回归 → 已在 Task 9 step 2 验证
- [x] 项目成员能进入 `/workspace/<slug>` 看到首页 → 已在 Task 6 step 4 验证
- [x] `tests/integration_test.sh` 全绿 → 已在本 Task step 2 验证
- [x] 新增 `tests/m1_workspace_test.sh` 全绿 → 已在本 Task step 2 验证

- [ ] **Step 4: 如果 README 修改了，commit；否则跳过**

```bash
git add README.md  # 仅在 step 1 改动了 README 时
git commit -m "docs(m1): document project workspace endpoints and routes"
```

- [ ] **Step 5: 标记 M1 完成 → 启动 Plan 2/3/4 撰写**

提示协作者：

> M1 已完成。可以开始撰写 `2026-05-13-m2-onboarding-wizard.md` / `2026-05-13-m3-visual-schema.md` / `2026-05-13-m6-dashboard-simplified.md`，三个 plan 可并行执行。

---

## Verification Summary

Plan 完成时应满足：

| 验证项 | 命令 | 期望 |
|---|---|---|
| 编译通过 | `cargo build` | `Finished` 无 error |
| Rust 单测 | `cargo test --bin onebase` | 4 个新增测试全 ok，无回归 |
| Migration 幂等 | `cargo run --bin migrate`（跑 2 次） | 第 2 次 `errors=0` |
| 后端 smoke | `curl http://127.0.0.1:3010/health` | 200 |
| 现有集成 | `./tests/integration_test.sh` | exit 0 |
| 新增集成 | `./tests/m1_workspace_test.sh` | `PASS=5 FAIL=0`, exit 0 |
| 前端构建 | `cd frontend-nextjs && npm run build` | 无 error |
| Workspace 路由 | 浏览器访问 `/workspace/company-a` | 显示项目首页 + 6 个占位卡片 |

---

## Open Questions / 风险提醒

1. **现有用户角色无 project_owner**：Task 1 只是在注释里约定了角色名。现有 user_tenants.role 仍为 `owner` / `admin` / `member` / `viewer`。Task 4 的 PATCH config 把 `owner` 也当作 owner 处理（`matches!(role.as_deref(), Some("project_owner") | Some("owner"))`）以兼容。M4 阶段会真正落地角色矩阵。

2. **dashboard layout 的项目跳转**：Task 9 的判断条件是 "非超管 + 有 current_project_slug 就跳"。如果客户场景里有"超管也想体验工作空间"的需求，可以去掉 `!user.is_superadmin` 判断；但默认按"超管走 /platform，其它人走 /workspace"更清晰。

3. **测试数据 seed**：`tests/m1_workspace_test.sh` 里直接 `psql UPDATE` 把 company-a 升为 project，依赖测试环境有 `psql` 命令和 `DATABASE_URL`。CI 环境若不满足，需要改为通过 API 写入或在测试入口 skip。

4. **没有 OpenAPI 自动生成**：M1 暴露的 3 个新端点没有自动文档。本 plan 不解决（属于 GA 阶段的整体债务）。

---

*本 plan 是 `docs/superpowers/plans/2026-05-13-mvp-overview.md` 的子项。完成后请回头标记总览中的 Plan 1 状态为「✅ 已完成」并启动 Plan 2/3/4 撰写。*
