//! License 功能限制运行时强制执行
//!
//! 根据 License 的 edition / modules / max_nodes / max_tenants 字段，
//! 在运行时拦截不符合授权的操作。

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use sqlx::PgPool;

use crate::auth::Claims;
use crate::error::{AppError, Result};
use onebase::license::{self, LicenseClaims, LicenseStatus};

/// License 上下文（由 license_middleware 注入）
#[derive(Debug, Clone)]
pub struct LicenseContext {
    pub claims: LicenseClaims,
    pub status: LicenseStatus,
}

impl LicenseContext {
    /// 检查是否启用了指定模块
    pub fn has_module(&self, module: &str) -> bool {
        self.claims.modules.iter().any(|m| m.eq_ignore_ascii_case(module))
    }

    /// 检查版本是否满足最低要求
    pub fn has_edition(&self, required: &str) -> bool {
        // 版本等级：trial < standard < enterprise
        let level = |ed: &str| match ed.to_lowercase().as_str() {
            "trial" => 0,
            "standard" => 1,
            "enterprise" => 2,
            _ => 0,
        };

        level(&self.claims.edition) >= level(required)
    }

    /// 检查是否可以创建新租户（是否达到上限）
    pub async fn can_create_tenant(&self, pool: &PgPool) -> Result<bool> {
        if let Some(max_tenants) = self.claims.max_tenants {
            let current_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.tenants WHERE status = 'active'",
            )
            .fetch_one(pool)
            .await?;

            Ok(current_count < max_tenants as i64)
        } else {
            Ok(true) // 无限制
        }
    }

    /// 检查是否可以添加新节点（集群规模限制）
    pub async fn can_add_node(&self, pool: &PgPool) -> Result<bool> {
        if let Some(max_nodes) = self.claims.max_nodes {
            // 这里需要根据实际的节点管理表查询
            // 示例：假设有一个 cluster_nodes 表
            let current_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.cluster_nodes WHERE status = 'active'",
            )
            .fetch_optional(pool)
            .await?
            .unwrap_or(1); // 默认单节点

            Ok(current_count < max_nodes as i64)
        } else {
            Ok(true) // 无限制
        }
    }

    /// 检查租户是否可以添加新账号（单租户账号数限制）
    pub async fn can_add_account(&self, pool: &PgPool, tenant_id: i32) -> Result<bool> {
        if let Some(max_accounts) = self.claims.max_accounts_per_tenant {
            let current_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.user_tenants WHERE tenant_id = $1 AND is_active = true",
            )
            .bind(tenant_id)
            .fetch_one(pool)
            .await?;

            Ok(current_count < max_accounts as i64)
        } else {
            Ok(true) // 无限制
        }
    }
}

/// License 中间件：加载并验证 License，注入到请求上下文
///
/// 挂载位置：在 auth_middleware 之后，业务 handler 之前
pub async fn license_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> std::result::Result<Response, AppError> {
    // 加载 License
    let license_ctx = match load_and_verify_license(&pool).await {
        Ok(ctx) => ctx,
        Err(e) => {
            // License 无效或已过期，根据 enforce 模式决定是否拦截
            let enforce_mode = license::EnforceMode::from_env();
            if enforce_mode == license::EnforceMode::Enforce {
                return Err(AppError::Forbidden(format!("License 无效: {}", e)));
            } else {
                // warn 模式：记录日志但不拦截
                tracing::warn!("License 校验失败（warn 模式，继续执行）: {}", e);
                return Ok(next.run(req).await);
            }
        }
    };

    // 注入 License 上下文到请求扩展
    req.extensions_mut().insert(license_ctx);

    Ok(next.run(req).await)
}

/// 加载并验证 License
async fn load_and_verify_license(_pool: &PgPool) -> Result<LicenseContext> {
    // 注意：这个函数应该使用全局 LicenseState，但为了演示功能注册表
    // 这里暂时实现一个简化版本。生产环境应该使用 Extension<LicenseState>

    // 临时实现：返回一个默认的 License（仅用于演示）
    // TODO: 改为从全局 LicenseState 或环境变量获取真实 License
    Err(AppError::Internal(
        "license_enforcement 模块需要重构以使用全局 LicenseState".to_string(),
    ))
}

// ═══════════════════════════════════════════════════════════
// 功能限制检查函数（业务代码调用）
// ═══════════════════════════════════════════════════════════

/// 要求启用指定模块
pub fn require_module(ctx: &LicenseContext, module: &str) -> Result<()> {
    if ctx.has_module(module) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "当前 License 未授权「{}」模块，请升级 License",
            module
        )))
    }
}

/// 要求版本满足最低等级
pub fn require_edition(ctx: &LicenseContext, required: &str) -> Result<()> {
    if ctx.has_edition(required) {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "此功能需要「{}」版本或更高版本，当前为「{}」",
            required, ctx.claims.edition
        )))
    }
}

/// 检查租户数量限制
pub async fn check_tenant_limit(ctx: &LicenseContext, pool: &PgPool) -> Result<()> {
    if ctx.can_create_tenant(pool).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "已达到租户数量上限（{}），请升级 License 或删除未使用的租户",
            ctx.claims.max_tenants.unwrap_or(0)
        )))
    }
}

/// 检查节点数量限制
pub async fn check_node_limit(ctx: &LicenseContext, pool: &PgPool) -> Result<()> {
    if ctx.can_add_node(pool).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "已达到节点数量上限（{}），请升级 License",
            ctx.claims.max_nodes.unwrap_or(0)
        )))
    }
}

/// 检查租户账号数量限制
pub async fn check_account_limit(ctx: &LicenseContext, pool: &PgPool, tenant_id: i32) -> Result<()> {
    if ctx.can_add_account(pool, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "租户已达到账号数量上限（{}），请升级 License",
            ctx.claims.max_accounts_per_tenant.unwrap_or(0)
        )))
    }
}

// ═══════════════════════════════════════════════════════════
// Axum Extractor（在 handler 签名中直接获取 License）
// ═══════════════════════════════════════════════════════════

use axum::{
    async_trait,
    extract::FromRequestParts,
    http::request::Parts,
};

#[async_trait]
impl<S> FromRequestParts<S> for LicenseContext
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<LicenseContext>()
            .cloned()
            .ok_or_else(|| {
                AppError::Internal("License 上下文未注入（请确保挂载了 license_middleware）".to_string())
            })
    }
}
