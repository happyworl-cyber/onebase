//! 集中式权限/身份判定辅助
//!
//! 本模块统一原先散落在 7 个 handler 文件里的鉴权小函数，提供 4 类能力：
//!
//! 1. **平台超管**（`users.is_superadmin = true`）
//!    - `is_platform_superadmin(pool, user_id)`
//!    - `require_platform_superadmin(claims)`（从已签发的 JWT Claims 直接判断）
//! 2. **租户管理员**（`management.user_tenants.role IN ('owner','admin')`）
//!    - `tenant_admin_ids(pool, claims)`：当前用户管理的全部 tenant_id；超管返回空向量
//!      表示"无 tenant 限制"（调用方负责单独处理）
//!    - `is_tenant_admin(pool, user_id, tenant_id)`
//!    - `require_tenant_admin(pool, claims, tenant_id)`：超管直接放行
//! 3. **数据库归属判定**
//!    - `lookup_tenant_for_database(pool, database_id)`：反查 `tenant_databases.tenant_id`
//!    - `require_database_admin(pool, claims, database_id)`：要么超管，要么该 db 所属 tenant 的 owner/admin
//! 4. **统计**
//!    - `count_platform_superadmins(pool)`：用于"不允许删除最后一个超管"的护栏
//!
//! 设计原则：
//! - **JWT 中的 `is_superadmin` 是权威字段**。已经经过 `auth_middleware` 写入请求扩展的 Claims
//!   直接信任；只有"不通过 Claims，仅有 user_id"的场景才会回到 DB 查 `users.is_superadmin`。
//! - 所有"租户管理员"判定一律是 `owner` 或 `admin`，不再各文件自己写 `IN ('owner','admin')`。
//! - 错误信息固定中文 + 业务可读，避免每个 handler 自己拼字符串导致 UI 提示风格漂移。

use axum::{
    async_trait,
    extract::{FromRef, FromRequestParts},
    http::{request::Parts, HeaderMap},
};
use sqlx::PgPool;

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permission_cache::PermissionCache;
use crate::redis_manager::RedisManager;

/// 租户层"管理员"角色集合（owner / admin）
///
/// `member` / `viewer` 不算"租户管理员"，无权管理 Webhook / API Key / RBAC 等元数据。
///
/// 目前所有 SQL 内嵌了字面量 `IN ('owner', 'admin')`，这个常量只是单源声明，
/// 用来给 reviewers / 单测做"语义锚定"。未来如果引入更细的角色（如 'super_owner'），
/// 必须同步更新这里并 grep 修补所有 SQL。
#[allow(dead_code)]
pub const TENANT_ADMIN_ROLES: &[&str] = &["owner", "admin"];

// ───── 1. 平台超管 ─────────────────────────────────────────

/// 从 Claims 快速断言"必须是平台超管"。
///
/// 用于 handler 入口的快路径——JWT 已经验签 + 会话有效，`is_superadmin` 字段
/// 就是权威；这里 **不** 再回到 DB 复查，避免每次请求多打一次 SQL。
/// 如果担心"提权后旧 token 仍有效"问题：那是 `admin_update_user` 的责任——
/// 它会在 is_superadmin 翻转后 `DELETE FROM user_sessions WHERE user_id = ?`，
/// 旧 token 在下次 `auth_middleware` 校验 jti 时就会被拒。
pub fn require_platform_superadmin(_claims: &Claims) -> Result<()> {
    // 平台超管限制已按需求移除：任何已认证用户均放行（调用点都在 auth_middleware 之后，
    // 即已登录用户）。保留函数签名，避免改动所有调用方。
    Ok(())
}

/// 直接按 user_id 回到 DB 查 is_superadmin。
///
/// 仅在"没有 Claims，只有 user_id"的场景使用（例如 rbac_middleware 在
/// API Key 链路上还没有用户主体）。普通 handler 应当走 `require_platform_superadmin(&claims)`。
pub async fn is_platform_superadmin(pool: &PgPool, user_id: i32) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT COALESCE(is_superadmin, false) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

// ───── 2. 租户管理员 ───────────────────────────────────────

/// 当前用户管理（owner/admin）的全部 tenant_id 列表。
///
/// 语义约定：
/// - 平台超管 → 返回 **空向量** 表示"无 tenant 限制"。调用方拿到空向量后应当
///   走"全表查询、不加 tenant 过滤"分支，而 **不是** 认为该用户无权限。
/// - 非超管 → 仅返回 `user_tenants.role IN ('owner','admin')` 且 active 的 tenant_id。
pub async fn tenant_admin_ids(pool: &PgPool, claims: &Claims) -> Result<Vec<i32>> {
    if claims.is_superadmin {
        return Ok(vec![]);
    }
    let rows = sqlx::query_scalar::<_, i32>(
        "SELECT tenant_id \
         FROM management.user_tenants \
         WHERE user_id = $1 AND is_active = true AND role IN ('owner', 'admin')",
    )
    .bind(claims.sub)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// 当前用户以 **member 及以上**（owner/admin/member）身份所属的全部 tenant_id 列表。
///
/// 与 `tenant_admin_ids` 语义一致（超管 → 空向量表示"无 tenant 限制"），但把 `member`
/// 也纳入。用于"业务级资产"（如工作流）的默认列表作用域：开发者（member）应能看到
/// 自己所在租户的工作流。viewer 不含。
pub async fn tenant_member_ids(pool: &PgPool, claims: &Claims) -> Result<Vec<i32>> {
    if claims.is_superadmin {
        return Ok(vec![]);
    }
    let rows = sqlx::query_scalar::<_, i32>(
        "SELECT tenant_id \
         FROM management.user_tenants \
         WHERE user_id = $1 AND is_active = true AND role IN ('owner', 'admin', 'member')",
    )
    .bind(claims.sub)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// 检查指定 user 是不是指定 tenant 的 owner/admin。
///
/// 不考虑平台超管——超管路径调用方应当自己短路（`if claims.is_superadmin { return Ok(()) }`），
/// 或者使用 `require_tenant_admin` 让本函数帮你处理超管放行。
pub async fn is_tenant_admin(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants \
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true \
              AND role IN ('owner', 'admin'))",
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

/// 要求调用者是"平台超管"或"该 tenant 的 owner/admin"。
///
/// 用于所有 per-tenant 元数据写操作（Webhook、SSO Provider、RBAC 角色/权限、租户连接 等）。
pub async fn require_tenant_admin(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    if is_tenant_admin(pool, claims.sub, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "需要租户 owner/admin 角色或平台超管才能管理租户 {} 的资源",
            tenant_id
        )))
    }
}

/// 检查指定 user 是不是指定 tenant 的 owner/admin/**member**（含开发者）。
///
/// 比 `is_tenant_admin` 更宽——member 也算。用于"开发者要能做但 viewer 不能"
/// 的业务级操作：DDL（M3 建表/改表）、写业务数据、调用 RPC 等。
///
/// 不含 viewer。viewer 只能读。
pub async fn is_tenant_member(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants \
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true \
              AND role IN ('owner', 'admin', 'member'))",
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

/// 检查指定 user 是否是该 tenant 的**任意 active 成员**（owner/admin/member/viewer）。
///
/// 用于"任意租户成员都可见的只读视图"：项目首页大盘的聚合指标 / sanitized 活动 feed。
/// 比 `is_tenant_member` 还宽——含 viewer。
pub async fn is_tenant_membership_any(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants \
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

/// 要求调用者是"平台超管"或"该 tenant 的任意 active 成员"。
///
/// 给 M6 大盘这类**纯只读、纯聚合数字**视图用。viewer 也能看——不暴露行级业务数据。
pub async fn require_tenant_membership_any(
    pool: &PgPool,
    claims: &Claims,
    tenant_id: i32,
) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    if is_tenant_membership_any(pool, claims.sub, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "需要租户 {} 的任意角色（owner/admin/member/viewer）或平台超管才能查看其只读视图",
            tenant_id
        )))
    }
}

/// 要求调用者是"平台超管"或"该 tenant 的 owner/admin/member"。
///
/// 与 `require_tenant_admin` 的差异：member 也放行——给"业务级写操作"
/// （M3 DDL、业务数据写、RPC 等）使用。viewer 不放行。
pub async fn require_tenant_member(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    if is_tenant_member(pool, claims.sub, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "需要租户 owner/admin/member 角色或平台超管才能在租户 {} 内执行业务级写操作（viewer 仅可读）",
            tenant_id
        )))
    }
}

/// 检查指定 user 是不是指定 tenant 的 owner（不含 admin）。
///
/// 比 `is_tenant_admin` 更收紧——用于"必须 owner 才能做"的项目元信息编辑、
/// 转让所有权之类的高敏感操作。
pub async fn is_tenant_owner(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
            SELECT 1 FROM management.user_tenants \
            WHERE user_id = $1 AND tenant_id = $2 AND is_active = true \
              AND role = 'owner')",
    )
    .bind(user_id)
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

/// 要求调用者是"平台超管"或"该 tenant 的 owner"（**不放 admin**）。
///
/// 用于项目元信息编辑（`PATCH /api/projects/:id`）、转让所有权等
/// owner-only 路径。比 `require_tenant_admin` 严格一级。
pub async fn require_tenant_owner(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    if is_tenant_owner(pool, claims.sub, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "需要 owner 角色或平台超管才能管理项目 {} 的元信息",
            tenant_id
        )))
    }
}

/// 数一下指定 tenant 还有几个 active 的 owner。
///
/// 用于"不允许把最后一个 owner 降级 / 移除"的护栏。
pub async fn count_tenant_owners(pool: &PgPool, tenant_id: i32) -> Result<i64> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM management.user_tenants \
         WHERE tenant_id = $1 AND is_active = true AND role = 'owner'",
    )
    .bind(tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

// ───── 3. 数据库归属 ───────────────────────────────────────

/// 由 `tenant_databases.id` 反查所属 tenant_id（必须 active）。
///
/// 用于"接口入参是 database_id，但鉴权基于 tenant_id"的常见路径
/// （API Key 管理、监控、导出等）。
pub async fn lookup_tenant_for_database(pool: &PgPool, database_id: i32) -> Result<i32> {
    let row: Option<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases \
         WHERE id = $1 AND is_active = true",
    )
    .bind(database_id)
    .fetch_optional(pool)
    .await?;
    row.ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在或已停用", database_id)))
}

/// 由对外 `database_slug` 解析内部 `database_id`（仅 active 连接）。
///
/// 规则：
/// - 若 slug 可解析为数字，直接按 id 使用（兼容历史调用方）
/// - 超管：可解析任意 active 库；若同 slug 在多租户冲突，返回歧义错误
/// - 普通用户：仅可解析自己所属租户里的库；冲突同样返回歧义错误
pub async fn resolve_database_id_by_slug_for_claims(
    pool: &PgPool,
    claims: &Claims,
    database_slug: &str,
) -> Result<i32> {
    if let Ok(id) = database_slug.parse::<i32>() {
        return Ok(id);
    }

    let ids: Vec<i32> = if claims.is_superadmin {
        sqlx::query_scalar(
            "SELECT id FROM management.tenant_databases \
             WHERE slug = $1 AND is_active = true \
             ORDER BY id ASC LIMIT 2",
        )
        .bind(database_slug)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT td.id \
             FROM management.tenant_databases td \
             JOIN management.user_tenants ut \
               ON ut.tenant_id = td.tenant_id \
              AND ut.user_id = $1 \
              AND ut.is_active = true \
             WHERE td.slug = $2 AND td.is_active = true \
             ORDER BY td.id ASC LIMIT 2",
        )
        .bind(claims.sub)
        .bind(database_slug)
        .fetch_all(pool)
        .await?
    };

    match ids.len() {
        0 => Err(AppError::NotFound(format!(
            "数据库 slug '{}' 不存在或无权访问",
            database_slug
        ))),
        1 => Ok(ids[0]),
        _ => Err(AppError::InvalidQuery(format!(
            "database_slug '{}' 存在歧义，请切换到更精确上下文或使用 API Key",
            database_slug
        ))),
    }
}

/// 要求调用者是"平台超管"或"database_id 所属租户的 owner/admin"。
///
/// 用于 API Key 管理、租户级 Webhook 测试等"对一个具体 database 做配置变更"的接口。
/// 区别于 `require_tenant_admin`：调用方手里只有 database_id，由本函数完成反查。
pub async fn require_database_admin(
    pool: &PgPool,
    claims: &Claims,
    database_id: i32,
) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    let tenant_id = lookup_tenant_for_database(pool, database_id).await?;
    require_tenant_admin(pool, claims, tenant_id).await
}

/// 要求调用者是"平台超管"或"该 database 所属 tenant 的 owner/admin/**member**"。
///
/// 比 `require_database_admin` 更宽——给业务级写操作（M3 表 DDL、业务数据写、RPC 等）用。
/// viewer 不放行。
pub async fn require_database_member(
    pool: &PgPool,
    claims: &Claims,
    database_id: i32,
) -> Result<()> {
    if claims.is_superadmin {
        return Ok(());
    }
    let tenant_id = lookup_tenant_for_database(pool, database_id).await?;
    require_tenant_member(pool, claims, tenant_id).await
}

// ───── 4. 统计 ─────────────────────────────────────────────

/// 数一下当前系统里还有多少个有效的平台超管。
///
/// 用于"不允许删/降级最后一个超管"的护栏。
pub async fn count_platform_superadmins(pool: &PgPool) -> Result<i64> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE COALESCE(is_superadmin, false) = true",
    )
    .fetch_one(pool)
    .await?;
    Ok(n)
}

// ───── 4.5 数据面 API Key 读写 scope 判定（Auto API / 工作流共用）─────
//
// **单一事实来源**：`rbac_middleware::check_api_key_scope` 的 action 分支与工作流只读
// 护栏（`ExecutionContext.apikey_write_guard`）都复用 `api_key_action_allowed`，避免同
// 一把 key 在两条路上判权口径漂移。护栏走 `api_key_declares_readonly` 入口，只在「空
// permissions」这一处放宽（见其文档注释）。
//
// 只判「动作类别（读/写）」，**不看 `allowed_resources`**——资源限制与读写正交，逐表
// 逐动作校验属二期。permissions JSONB 支持两种格式：
// - 新格式：`{ "allowed_actions": ["SELECT","INSERT",...] }`；空数组 / 缺失 = 不限（放行）。
// - 旧格式：`{ "read":bool, "write":bool, "delete":bool }`；read=SELECT，write=INSERT|UPDATE，
//   delete=DELETE。空对象 `{}` 落旧格式且三个字段皆缺 → 一律不允许。

/// 该 key 是否允许执行给定 SQL 动作。`action` 传大写 `SELECT`/`INSERT`/`UPDATE`/`DELETE`。
///
/// 语义与 `check_api_key_scope` 的 action 分支**逐条对齐**（本函数即其抽取结果）。
pub fn api_key_action_allowed(permissions: &serde_json::Value, action: &str) -> bool {
    // 新格式优先：出现 allowed_actions / allowed_resources 任一即视为新格式。
    let new_format = permissions.get("allowed_actions").is_some()
        || permissions.get("allowed_resources").is_some();

    if new_format {
        let actions = permissions
            .get("allowed_actions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_uppercase))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // 空 allowed_actions 视为不限（与 check_api_key_scope 一致）。
        return actions.is_empty()
            || actions
                .iter()
                .any(|a| a == "*" || a == action || a == "ALL");
    }

    // 旧格式：仅按 action 类别校验。
    match action {
        "SELECT" => permissions
            .get("read")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "INSERT" | "UPDATE" => permissions
            .get("write")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "DELETE" => permissions
            .get("delete")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        _ => false,
    }
}

/// 该 key 是否允许**任一**写动作（INSERT / UPDATE / DELETE）。
pub fn api_key_write_allowed(permissions: &serde_json::Value) -> bool {
    api_key_action_allowed(permissions, "INSERT")
        || api_key_action_allowed(permissions, "UPDATE")
        || api_key_action_allowed(permissions, "DELETE")
}

/// 该 key 是否**显式声明**了自己只读——工作流只读护栏的判定入口。
///
/// 与 `api_key_write_allowed` 的差别只在空值语义，且这个差别是刻意的：
/// `permissions` 为空对象或非对象（建表默认值是全权限，出现空值意味着有人清过或
/// 数据异常）时无从判断意图，护栏按**不限制**处理，不拦也不报错；只有显式声明过
/// 权限且不含任何写动作的 key 才算只读。若此处跟着 `api_key_write_allowed` 把空值
/// 判成只读，enforce 一开，所有 permissions 被清空的存量 key 触发的写工作流会立刻
/// 403。数据面 RBAC（`check_api_key_scope`）仍走 `api_key_action_allowed` 的严格
/// 语义，不受这里放宽的影响。
pub fn api_key_declares_readonly(permissions: &serde_json::Value) -> bool {
    let declared = permissions.as_object().is_some_and(|o| !o.is_empty());
    declared && !api_key_write_allowed(permissions)
}

// ───── 5. 租户上下文解析 ────────────────────────────────────
//
// 旧逻辑（`resolve_tenant_id`）做"用户加入的第一个租户"兜底，
// 对一个用户加入了多个租户的场景就会随机命中错误租户，并且超管不在 user_tenants
// 时直接 403（即使路由层的 `require_superadmin_middleware` 已经放行）。
//
// 新模型：
//   1) 优先用调用方显式给的 tenant_id（来自 `X-Tenant-Id` 请求头，或 `?tenant_id=N`）；
//   2) 调用方没指定时——
//        - 超管：直接 400，让调用方明确选择，避免"超管手滑动到错误租户"；
//        - 普通用户：恰好属于 1 个 active 租户时复用旧的兜底；属于多个或 0 个均报错。
//   3) 显式 tenant_id：
//        - 超管：只要该租户存在即可（不要求他加入 user_tenants）；
//        - 普通用户：必须在 user_tenants 中且 active。

const TENANT_ID_HEADER: &str = "x-tenant-id";

/// 租户绑定资源（ES/Kafka/Redis 连接等）列表的过滤范围。
///
/// 与 webhook / sse-routes 一致：显式 `tenant_id` 必须生效，避免多项目 admin
/// 在项目 A 工作空间里拿到项目 B 的连接与密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TenantListFilter {
    /// 超管且未指定租户：全平台。
    All,
    /// 指定单个租户（调用方需已通过 admin 校验，或本函数已校验）。
    One(i32),
    /// 非超管且未指定租户：其全部管辖租户（平台级总览用）。
    Many(Vec<i32>),
}

/// 解析连接类列表的租户过滤范围。
///
/// - `requested = Some(t)`：只返回该租户；非超管必须是其 admin，否则 Forbidden。
/// - `requested = None` + 超管：全平台。
/// - `requested = None` + 非超管：其全部 admin 租户。
pub fn resolve_tenant_list_filter(
    is_superadmin: bool,
    requested: Option<i32>,
    admin_tenant_ids: &[i32],
) -> Result<TenantListFilter> {
    match requested {
        Some(tid) => {
            if is_superadmin || admin_tenant_ids.contains(&tid) {
                Ok(TenantListFilter::One(tid))
            } else {
                Err(AppError::Forbidden(
                    "仅超管或该租户 owner/admin 可查看此项目的连接".to_string(),
                ))
            }
        }
        None if is_superadmin => Ok(TenantListFilter::All),
        None => Ok(TenantListFilter::Many(admin_tenant_ids.to_vec())),
    }
}

/// 从 `X-Tenant-Id` 请求头或 query string `?tenant_id=N` 中解析显式 tenant_id。
///
/// 两者都没有 → `None`；解析失败（非数字）→ `None`，由 `resolve_tenant_context`
/// 走"无显式选择"分支兜底。
pub fn parse_explicit_tenant_id(headers: &HeaderMap, query: Option<&str>) -> Option<i32> {
    if let Some(v) = headers.get(TENANT_ID_HEADER) {
        if let Ok(s) = v.to_str() {
            if let Ok(n) = s.parse::<i32>() {
                return Some(n);
            }
        }
    }
    if let Some(qs) = query {
        for pair in qs.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?;
            let v = it.next()?;
            if k == "tenant_id" {
                if let Ok(n) = v.parse::<i32>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// 解析"本次请求要操作的租户 ID"。
///
/// 调用方一般通过 `TenantContext` 提取器隐式调用，但也支持手工调用（test / handler 复用）。
pub async fn resolve_tenant_context(
    pool: &PgPool,
    claims: &Claims,
    explicit: Option<i32>,
) -> Result<i32> {
    if let Some(tid) = explicit {
        if claims.is_superadmin {
            // 超管：只要租户存在即可
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM management.tenants WHERE id = $1)")
                    .bind(tid)
                    .fetch_one(pool)
                    .await?;
            if !exists {
                return Err(AppError::NotFound(format!("租户 {} 不存在", tid)));
            }
            return Ok(tid);
        }
        // 普通用户：必须是该租户的 active 成员
        let member: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM management.user_tenants \
             WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)",
        )
        .bind(claims.sub)
        .bind(tid)
        .fetch_one(pool)
        .await?;
        if !member {
            return Err(AppError::Forbidden(format!(
                "您不属于租户 {}，无权操作",
                tid
            )));
        }
        return Ok(tid);
    }

    // 调用方没显式选——
    if claims.is_superadmin {
        return Err(AppError::InvalidQuery(
            "超管必须通过 X-Tenant-Id 请求头或 ?tenant_id=N 显式指定要操作的租户".to_string(),
        ));
    }

    let ids: Vec<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.user_tenants \
         WHERE user_id = $1 AND is_active = true \
         ORDER BY tenant_id",
    )
    .bind(claims.sub)
    .fetch_all(pool)
    .await?;

    match ids.len() {
        0 => Err(AppError::Forbidden(
            "您未关联任何租户，无权执行此操作".to_string(),
        )),
        1 => Ok(ids[0]),
        _ => Err(AppError::InvalidQuery(format!(
            "您同时属于 {} 个租户，请通过 X-Tenant-Id 显式指定要操作的租户",
            ids.len()
        ))),
    }
}

// ───── 6. 权限缓存 + 会话失效 ──────────────────────────────
//
// 改 role/permission/user_role 之后必须做两件事，否则用户会用"旧权限"或"旧 token"
// 继续访问到刚被撤销的资源：
//   - 失效 Redis 里的 `perm:{tenant}:{user}:*` 缓存（PermissionCache TTL 300s）；
//   - （仅在权限升级/超管位翻转时）吊销 `user_sessions`，让对方下一次请求触发重登录。
// 这里提供 3 个通用助手，调用方按"动作"挑：
//   - `invalidate_tenant_permissions`：role/permission 定义变更（影响整个租户的所有人）；
//   - `invalidate_user_permissions`：user_role 关系变更（只影响特定用户）；
//   - `revoke_user_sessions`：身份元数据变更（is_superadmin / 租户成员变更 / 密码重置）。
//
// 注意：Redis 可能未配置（开发或单机模式），所以入参是 `Option<&RedisManager>`，
// 没有就静默跳过——下次请求会从 DB 重新加载，最多多打一次 SQL，不会出现"旧权限放行"。

/// 失效该租户下所有用户的权限缓存。
///
/// 用于 role 创建/修改/删除、permission 创建/修改/删除、role-permission 绑定变更等
/// "定义级"动作——这些动作影响的是同一租户内所有挂了该 role 的用户。
pub async fn invalidate_tenant_permissions(redis: Option<&RedisManager>, tenant_id: i32) {
    if let Some(r) = redis {
        PermissionCache::invalidate_tenant(r, tenant_id).await;
    }
}

/// 失效单个用户在指定租户下的权限缓存。
///
/// 用于 `assign_user_role` / `remove_user_role` 这类"关系级"动作——仅一个用户的
/// 视图改变，不需要清整租户缓存。
pub async fn invalidate_user_permissions(
    redis: Option<&RedisManager>,
    tenant_id: i32,
    user_id: i32,
) {
    if let Some(r) = redis {
        PermissionCache::invalidate_user(r, tenant_id, user_id).await;
    }
}

// ───── 6.5. 租户角色 ↔ RBAC 角色 默认映射 ──────────────────
//
// `management.user_tenants.role` 决定的是"在 tenant 元数据层面能不能管 webhook/SSO/角色"——
// 但它**不会**自动产生 Auto API / RBAC 上的资源访问权限。换句话说，admin 把一个
// 用户加入租户后，用户在数据接口上还是 0 权限（除非 admin 再去 RBAC 面板手动配）。
//
// 这里给出一个开箱即用的默认映射：
//   owner / admin       → RBAC `admin`  （全资源 ALL）
//   member              → RBAC `editor` （全资源 SELECT/INSERT/UPDATE）
//   viewer              → RBAC `viewer` （全资源 SELECT）
//
// 调用方在"加入租户 / 修改租户角色"成功后调用 `sync_default_rbac_role`，
// 会做三件事：
//   1) 幂等 seed 当前 tenant 的 4 个系统 RBAC 角色与默认权限（避免 tenant 刚建好就拒人）；
//   2) 清掉该用户在该租户挂的"默认映射类"role（superadmin/admin/editor/viewer），
//      保留管理员后续手动加的自定义 role 不被覆盖；
//   3) 插入目标 role。
//
// 管理员若想给某用户一个完全定制的 RBAC 视图（比如 viewer + 单独 read 某张敏感表），
// 应当在调用本函数后再单独 assign 自定义 role；下次同步若 tenant role 没变就会维持现状。

/// 把 `user_tenants.role` 字符串映射到默认 RBAC role 名。
///
/// 不认识的角色返回 `None`，调用方按"不做映射"处理（同步函数会跳过 insert，
/// 但仍会清掉旧的默认映射——便于业务方未来扩展自定义 tenant 角色时优雅降级）。
pub fn default_rbac_role_for_tenant_role(tenant_role: &str) -> Option<&'static str> {
    match tenant_role {
        "owner" | "admin" => Some("admin"),
        "member" => Some("editor"),
        "viewer" => Some("viewer"),
        _ => None,
    }
}

/// 同步用户在指定租户的默认 RBAC 角色。
///
/// 详见模块注释。返回值是这次实际生效的 RBAC role 名（无映射时为 None）。
pub async fn sync_default_rbac_role(
    pool: &PgPool,
    redis: Option<&RedisManager>,
    user_id: i32,
    tenant_id: i32,
    tenant_role: &str,
) -> Result<Option<&'static str>> {
    // 1) 兜底 seed：覆盖"租户刚建好但 RBAC 默认还没写"的窗口（理论上 create_tenant 已经做了，
    //    但旧 tenant 在迁移之前可能不全，这里幂等补一刀）。
    crate::rbac_handlers::seed_tenant_rbac_defaults(pool, tenant_id).await?;

    // 2) 删除该用户在该租户挂的"默认映射类" role——只清这 3 个名字，不动管理员手动加的自定义 role。
    //    历史遗留的 `superadmin` 系统角色已经在 migration 014 里被平迁到 `admin` 并删除，
    //    所以这里不再需要清它；保留迁移前老 tenant 的兼容路径请运行该 migration。
    sqlx::query(
        "DELETE FROM management.user_roles ur \
         USING management.roles r \
         WHERE ur.role_id = r.id \
           AND ur.user_id = $1 AND ur.tenant_id = $2 \
           AND r.name IN ('admin', 'editor', 'viewer')",
    )
    .bind(user_id)
    .bind(tenant_id)
    .execute(pool)
    .await?;

    // 3) 找映射目标；找不到映射就只清不加（保留"未识别 tenant_role 的用户在 RBAC 上为空"语义）。
    let target = default_rbac_role_for_tenant_role(tenant_role);
    if let Some(role_name) = target {
        let role_id: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM management.roles WHERE tenant_id = $1 AND name = $2",
        )
        .bind(tenant_id)
        .bind(role_name)
        .fetch_optional(pool)
        .await?;

        if let Some(role_id) = role_id {
            sqlx::query(
                "INSERT INTO management.user_roles (user_id, role_id, tenant_id) \
                 VALUES ($1, $2, $3) ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING",
            )
            .bind(user_id)
            .bind(role_id)
            .bind(tenant_id)
            .execute(pool)
            .await?;
        } else {
            // 极少数情况：seed 完了但 role 还查不到——多半是 race condition 或 schema 损坏。
            // 不要 panic，记日志后跳过；下次调用会再尝试 seed。
            tracing::warn!(
                "default RBAC role '{}' missing in tenant {} after seed; skipping user_role bind",
                role_name,
                tenant_id
            );
        }
    }

    // 4) 失效该用户在该租户的权限缓存——不然 Redis 里旧的 perm 集合还在用。
    invalidate_user_permissions(redis, tenant_id, user_id).await;

    Ok(target)
}

/// 吊销用户所有活跃的 JWT 会话。
///
/// 触发场景：
/// - `is_superadmin` 位翻转（JWT 里写的 claim 是签发时的快照，必须强制重登录）；
/// - 用户被踢出某个租户（旧 token 里如果有 tenant 上下文也得作废）；
/// - 密码重置；
/// - 管理员显式封禁。
///
/// 实现是 `DELETE FROM user_sessions WHERE user_id = ?`——`auth_middleware` 校验 jti
/// 时找不到对应行即视为已吊销。`reason` 字段仅用于日志，方便后续审计。
pub async fn revoke_user_sessions(pool: &PgPool, user_id: i32, reason: &str) -> Result<u64> {
    let rows = sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| AppError::Internal(format!("吊销会话失败: {}", e)))?
        .rows_affected();
    if rows > 0 {
        tracing::info!(
            "已吊销用户 {} 的 {} 个活跃会话，原因: {}",
            user_id,
            rows,
            reason
        );
    }
    Ok(rows)
}

/// Axum 提取器：在 handler 签名里写 `TenantContext(tenant_id): TenantContext` 即可。
///
/// 依赖：
/// - 路由必须挂 `auth_middleware`，从而把 `Claims` 写入 request extensions；
/// - `State` 必须包含 `PgPool`（与现有 router 配置一致）。
pub struct TenantContext(pub i32);

#[async_trait]
impl<S> FromRequestParts<S> for TenantContext
where
    S: Send + Sync,
    PgPool: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        let claims = parts
            .extensions
            .get::<Claims>()
            .cloned()
            .ok_or_else(|| AppError::Unauthorized("未认证".to_string()))?;
        let explicit = parse_explicit_tenant_id(&parts.headers, parts.uri.query());
        let pool = PgPool::from_ref(state);
        let tid = resolve_tenant_context(&pool, &claims, explicit).await?;
        Ok(TenantContext(tid))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── api_key_action_allowed / api_key_write_allowed ──
    // 语义必须与 rbac_middleware::check_api_key_scope 的 action 分支逐条一致。

    #[test]
    fn write_allowed_old_format() {
        // 只读 key：仅 read。
        let ro = json!({ "read": true, "write": false, "delete": false });
        assert!(api_key_action_allowed(&ro, "SELECT"));
        assert!(!api_key_action_allowed(&ro, "INSERT"));
        assert!(!api_key_action_allowed(&ro, "UPDATE"));
        assert!(!api_key_action_allowed(&ro, "DELETE"));
        assert!(!api_key_write_allowed(&ro));

        // 读写 key（DB 默认值）。
        let rw = json!({ "read": true, "write": true, "delete": true });
        assert!(api_key_write_allowed(&rw));
        assert!(api_key_action_allowed(&rw, "INSERT"));

        // 仅 delete：write_allowed 也应为真（delete 属写动作之一）。
        let del = json!({ "read": true, "write": false, "delete": true });
        assert!(api_key_write_allowed(&del));
        assert!(!api_key_action_allowed(&del, "INSERT"));
        assert!(api_key_action_allowed(&del, "DELETE"));
    }

    #[test]
    fn write_allowed_new_format() {
        // allowed_actions 空 → 视为不限（允许所有动作）。
        let unlimited = json!({ "allowed_actions": [] });
        assert!(api_key_write_allowed(&unlimited));
        assert!(api_key_action_allowed(&unlimited, "INSERT"));

        // 仅 SELECT → 只读。
        let ro = json!({ "allowed_actions": ["SELECT"] });
        assert!(api_key_action_allowed(&ro, "SELECT"));
        assert!(!api_key_write_allowed(&ro));

        // 含 INSERT → 允许写。
        let with_insert = json!({ "allowed_actions": ["SELECT", "INSERT"] });
        assert!(api_key_write_allowed(&with_insert));

        // 通配 *。
        let star = json!({ "allowed_actions": ["*"] });
        assert!(api_key_write_allowed(&star));
        // 大小写不敏感。
        let lower = json!({ "allowed_actions": ["insert"] });
        assert!(api_key_write_allowed(&lower));

        // 仅 allowed_resources（无 allowed_actions）→ action 不限，视为允许写。
        let res_only = json!({ "allowed_resources": ["public.posts"] });
        assert!(api_key_write_allowed(&res_only));
    }

    #[test]
    fn write_allowed_empty_object_denies() {
        // 空对象落旧格式，三字段皆缺 → 一律不允许（与 check_api_key_scope 一致）。
        let empty = json!({});
        assert!(!api_key_write_allowed(&empty));
        assert!(!api_key_action_allowed(&empty, "SELECT"));
        assert!(!api_key_action_allowed(&empty, "INSERT"));
    }

    #[test]
    fn declares_readonly_needs_explicit_permissions() {
        // 显式只读（线上 shirehub-workflow-readonly 就是这个形状）→ 只读。
        assert!(api_key_declares_readonly(
            &json!({ "read": true, "write": false, "delete": false })
        ));
        assert!(api_key_declares_readonly(
            &json!({ "allowed_actions": ["SELECT"] })
        ));

        // 允许任一写动作 → 非只读。
        assert!(!api_key_declares_readonly(
            &json!({ "read": true, "write": true, "delete": true })
        ));
        assert!(!api_key_declares_readonly(
            &json!({ "read": true, "write": false, "delete": true })
        ));
        assert!(!api_key_declares_readonly(
            &json!({ "allowed_actions": ["SELECT", "INSERT"] })
        ));

        // 关键差异：空对象 / NULL / 非对象在护栏侧 fail-open，不判只读，
        // 与 api_key_write_allowed 的严格语义刻意分道。
        assert!(!api_key_declares_readonly(&json!({})));
        assert!(!api_key_write_allowed(&json!({})));
        assert!(!api_key_declares_readonly(&json!(null)));
        assert!(!api_key_declares_readonly(&json!("readonly")));

        // allowed_actions 为空数组同样是「不限」，不算只读。
        assert!(!api_key_declares_readonly(
            &json!({ "allowed_actions": [] })
        ));
    }

    fn claims(superadmin: bool) -> Claims {
        Claims {
            sub: 1,
            email: "u@example.com".to_string(),
            role: "user".to_string(),
            is_superadmin: superadmin,
            jti: "test".to_string(),
            exp: 9_999_999_999,
            iat: 0,
        }
    }

    #[test]
    fn superadmin_claims_passes_require() {
        assert!(require_platform_superadmin(&claims(true)).is_ok());
    }

    #[test]
    fn non_superadmin_claims_also_passes_require() {
        // 平台超管限制已移除：非超管用户现在同样放行。
        assert!(require_platform_superadmin(&claims(false)).is_ok());
    }

    #[test]
    fn tenant_admin_roles_constant_only_includes_owner_admin() {
        // 显式锚定语义：member/viewer 永远不算"租户管理员"。
        // 一旦未来要新增 super_owner 之类的角色，必须同步更新这个列表
        // 并修复所有使用它的 SQL（grep `TENANT_ADMIN_ROLES`）。
        assert_eq!(TENANT_ADMIN_ROLES, &["owner", "admin"]);
    }

    fn headers_with_tenant(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::HeaderName::from_static("x-tenant-id"),
            axum::http::HeaderValue::from_str(value).unwrap(),
        );
        h
    }

    #[test]
    fn parses_explicit_tenant_from_header() {
        let h = headers_with_tenant("42");
        assert_eq!(parse_explicit_tenant_id(&h, None), Some(42));
    }

    #[test]
    fn parses_explicit_tenant_from_query_string() {
        let h = HeaderMap::new();
        assert_eq!(
            parse_explicit_tenant_id(&h, Some("foo=bar&tenant_id=7&x=y")),
            Some(7)
        );
    }

    #[test]
    fn header_takes_priority_over_query() {
        let h = headers_with_tenant("1");
        // Header 优先；即使 query 也写了 tenant_id 也以 header 为准。
        assert_eq!(parse_explicit_tenant_id(&h, Some("tenant_id=2")), Some(1));
    }

    #[test]
    fn returns_none_when_nothing_supplied() {
        let h = HeaderMap::new();
        assert_eq!(parse_explicit_tenant_id(&h, None), None);
        assert_eq!(parse_explicit_tenant_id(&h, Some("foo=bar")), None);
    }

    #[test]
    fn returns_none_when_value_not_numeric() {
        let h = headers_with_tenant("not-a-number");
        assert_eq!(parse_explicit_tenant_id(&h, Some("tenant_id=abc")), None);
    }

    #[test]
    fn default_rbac_role_mapping_covers_known_tenant_roles() {
        // 锚定 user_tenants.role → RBAC role 的语义。
        // 一旦未来加新的 tenant_role（比如 'guest'），必须同步更新这里
        // 并决定它要不要默认拿到任何 RBAC 资格。
        assert_eq!(default_rbac_role_for_tenant_role("owner"), Some("admin"));
        assert_eq!(default_rbac_role_for_tenant_role("admin"), Some("admin"));
        assert_eq!(default_rbac_role_for_tenant_role("member"), Some("editor"));
        assert_eq!(default_rbac_role_for_tenant_role("viewer"), Some("viewer"));
        assert_eq!(default_rbac_role_for_tenant_role("guest"), None);
        assert_eq!(default_rbac_role_for_tenant_role(""), None);
    }

    // ── resolve_tenant_list_filter ──
    // 工作空间页会传 ?tenant_id=当前项目；多项目 admin 不得再拿到其它项目的连接/密钥。

    #[test]
    fn tenant_list_filter_honors_requested_tenant_for_multi_project_admin() {
        let admins = vec![1, 2];
        assert_eq!(
            resolve_tenant_list_filter(false, Some(1), &admins).unwrap(),
            TenantListFilter::One(1)
        );
        assert_eq!(
            resolve_tenant_list_filter(false, None, &admins).unwrap(),
            TenantListFilter::Many(vec![1, 2])
        );
        assert!(resolve_tenant_list_filter(false, Some(99), &admins).is_err());
    }

    #[test]
    fn tenant_list_filter_superadmin_all_or_one() {
        assert_eq!(
            resolve_tenant_list_filter(true, None, &[]).unwrap(),
            TenantListFilter::All
        );
        assert_eq!(
            resolve_tenant_list_filter(true, Some(7), &[]).unwrap(),
            TenantListFilter::One(7)
        );
    }
}
