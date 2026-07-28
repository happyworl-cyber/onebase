use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method},
    middleware::Next,
    response::Response,
};
use sqlx::{PgPool, Row};

use crate::auth::{verify_token, Claims};
use crate::error::AppError;
use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};

/// 读写分离池对，可通过 Extension 注入
#[derive(Clone)]
pub struct ReadWritePools {
    pub read: PgPool,
    pub write: PgPool,
}

/// 当前请求选中的租户数据库连接 ID（来自 `X-Database-Id` 请求头）。
/// 通过 Extension 暴露给需要做 RBAC（按 database_id → tenant_id）的 handler。
#[derive(Clone, Copy, Debug)]
pub struct CurrentDatabaseId(pub i32);

/// 当前请求隶属的租户 ID，由 `dynamic_db_middleware` 从 `management.tenant_databases`
/// 反查得到。只有 `database_id` 对应的库登记了 `tenant_id`（即非平台库）时才会注入。
///
/// 用途：让审计中间件 (`audit_middleware`) 可以填上 `audit_logs.tenant_id`，
/// 这样后续按租户拉高危调用列表时可以直接 `WHERE tenant_id = ?`，不必再 join
/// `tenant_databases`。`dynamic_db_middleware` 里已经查过这一列；这只是把结果再
/// 暴露到 request 扩展里，避免重复查询。
#[derive(Clone, Copy, Debug)]
pub struct CurrentTenantId(pub i32);

/// JWT 认证中间件
///
/// 工作流程：
/// 1. 校验签名 + 过期；
/// 2. 校验 jti 在 `user_sessions` 表中存在、未吊销且未过期。
///    若 jti 不存在（旧 token / 篡改 token）/ revoked=true / expires_at 过期 → 401。
pub async fn auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .or_else(|| {
            req.uri().query().and_then(|q| {
                q.split('&')
                    .find_map(|pair| pair.strip_prefix("token="))
            })
        })
        .ok_or_else(|| AppError::Unauthorized("缺少 Authorization header".to_string()))?;

    // If it's an API key (cr_ prefix), skip JWT validation.
    // Let rbac_middleware handle API key authentication downstream.
    if token.starts_with("cr_") {
        return Ok(next.run(req).await);
    }

    let claims = verify_token(token)?;

    // 校验服务端会话状态（jti 必须存在且未吊销）
    if claims.jti.is_empty() {
        return Err(AppError::Unauthorized(
            "Token 缺少 jti 字段，请重新登录".to_string(),
        ));
    }

    let session_row = sqlx::query(
        "SELECT revoked, expires_at FROM user_sessions WHERE jti = $1::uuid",
    )
    .bind(&claims.jti)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询会话状态失败: {}", e)))?;

    let row = match session_row {
        Some(r) => r,
        None => {
            return Err(AppError::Unauthorized(
                "会话不存在或已注销，请重新登录".to_string(),
            ))
        }
    };

    let revoked: bool = row.try_get("revoked").unwrap_or(false);
    if revoked {
        return Err(AppError::Unauthorized(
            "会话已被吊销，请重新登录".to_string(),
        ));
    }

    let expires_at: chrono::DateTime<chrono::Utc> = row
        .try_get("expires_at")
        .map_err(|e| AppError::Internal(format!("会话过期时间解析失败: {}", e)))?;
    if expires_at < chrono::Utc::now() {
        return Err(AppError::Unauthorized(
            "会话已过期，请重新登录".to_string(),
        ));
    }

    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}

/// 可选认证中间件（token 无效时不报错，仅在有效时添加用户信息）
///
/// 同样会校验 jti / 吊销状态；任一环节失败都直接视为"未登录"，不返回错误。
pub async fn optional_auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Response {
    if let Some(token) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            if h.starts_with("Bearer ") {
                Some(&h[7..])
            } else {
                None
            }
        })
    {
        if let Ok(claims) = verify_token(token) {
            if !claims.jti.is_empty() {
                let row = sqlx::query(
                    "SELECT revoked, expires_at FROM user_sessions WHERE jti = $1::uuid",
                )
                .bind(&claims.jti)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();

                if let Some(r) = row {
                    let revoked: bool = r.try_get("revoked").unwrap_or(false);
                    let expires_at: Option<chrono::DateTime<chrono::Utc>> = r.try_get("expires_at").ok();
                    let active = !revoked
                        && expires_at
                            .map(|t| t > chrono::Utc::now())
                            .unwrap_or(false);
                    if active {
                        req.extensions_mut().insert(claims);
                    }
                }
            }
        }
    }

    next.run(req).await
}

/// 动态数据库连接中间件
/// 从 X-Database-Id 请求头中获取数据库 ID，并从连接池管理器中获取对应的连接池
pub async fn dynamic_db_middleware(
    State(main_pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // 尝试从请求头中获取 X-Database-Id
    if let Some(db_id_str) = req.headers().get("X-Database-Id").and_then(|h| h.to_str().ok()) {
        tracing::info!("检测到 X-Database-Id 请求头: {}", db_id_str);
        if let Ok(database_id) = db_id_str.parse::<i32>() {
            // 从主数据库中获取连接配置
            
            let db_config_row = sqlx::query(
                r#"
                SELECT 
                    id, connection_name, db_host, db_port, db_name,
                    db_user, db_password_encrypted, max_connections, connection_timeout,
                    tenant_id
                FROM management.tenant_databases
                WHERE id = $1 AND is_active = true
                "#,
            )
            .bind(database_id)
            .fetch_optional(&main_pool)
            .await
            .map_err(|e| AppError::Internal(format!("查询数据库配置失败: {}", e)))?;

            if let Some(row) = db_config_row {
                // Tenant access validation: verify the authenticated user belongs to this tenant
                let tenant_id: Option<i32> = row.get("tenant_id");
                if let Some(tenant_id) = tenant_id {
                    if let Some(claims) = req.extensions().get::<Claims>() {
                        if !claims.is_superadmin {
                            let has_access = sqlx::query_scalar::<_, bool>(
                                "SELECT EXISTS(SELECT 1 FROM management.user_tenants WHERE user_id = $1 AND tenant_id = $2 AND is_active = true)"
                            )
                            .bind(claims.sub)
                            .bind(tenant_id)
                            .fetch_one(&main_pool)
                            .await
                            .unwrap_or(false);

                            if !has_access {
                                return Err(AppError::Forbidden("No access to this database".to_string()));
                            }
                        }
                    }
                    // 暴露给下游中间件 / handler：audit_middleware 用它填 audit_logs.tenant_id。
                    req.extensions_mut().insert(CurrentTenantId(tenant_id));
                }
                // 密码解密（v2 / 旧格式自动兼容）
                let encrypted_password: String = row.get("db_password_encrypted");
                let password = crate::crypto::decrypt_secret_lossy(&encrypted_password);

                let config = DatabaseConfig {
                    id: row.get("id"),
                    host: row.get("db_host"),
                    port: row.get("db_port"),
                    database: row.get("db_name"),
                    username: row.get("db_user"),
                    password: password.to_string(),
                    max_connections: row.get::<Option<i32>, _>("max_connections").unwrap_or(10) as u32,
                    connection_timeout: row.get::<Option<i32>, _>("connection_timeout").unwrap_or(30) as u64,
                };

                let pool = POOL_MANAGER.get_or_create_pool(config).await?;

                // 加载 replica（如果有）
                if let Ok(replicas) = sqlx::query(
                    "SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted, \
                            COALESCE(weight, 1) AS weight \
                     FROM management.tenant_databases \
                     WHERE primary_id = $1 AND is_active = true AND db_role = 'replica'"
                )
                .bind(database_id)
                .fetch_all(&main_pool)
                .await
                {
                    for rr in &replicas {
                        let rp: String = rr.get("db_password_encrypted");
                        let rpw = crate::crypto::decrypt_secret_lossy(&rp);
                        let replica_id: i32 = rr.get("id");
                        let weight: i32 = rr.get("weight");
                        let rc = DatabaseConfig {
                            id: replica_id,
                            host: rr.get("db_host"),
                            port: rr.get("db_port"),
                            database: rr.get("db_name"),
                            username: rr.get("db_user"),
                            password: rpw,
                            max_connections: 10,
                            connection_timeout: 30,
                        };
                        let _ = POOL_MANAGER
                            .upsert_replica(database_id, replica_id, weight, rc)
                            .await;
                    }
                }

                let read_pool = POOL_MANAGER.get_read_pool(database_id).unwrap_or_else(|| pool.clone());
                let write_pool = pool.clone();

                req.extensions_mut().insert(ReadWritePools {
                    read: read_pool,
                    write: write_pool.clone(),
                });
                req.extensions_mut().insert(write_pool);
                req.extensions_mut().insert(CurrentDatabaseId(database_id));
                tracing::info!("成功切换到数据库连接 ID: {}", database_id);
            } else {
                tracing::warn!("未找到数据库连接配置: ID={}", database_id);
            }
        } else {
            tracing::warn!("无效的数据库 ID 格式: {}", db_id_str);
        }
    } else {
        tracing::debug!("未提供 X-Database-Id 请求头，使用默认连接池");
    }

    Ok(next.run(req).await)
}

/// 从请求中获取当前用户信息
pub fn get_current_user(req: &Request) -> Option<&Claims> {
    req.extensions().get::<Claims>()
}

/// **已废弃**：用 `claims.role` 这个遗留显示字段做权限判定。
///
/// 保留这两个函数仅为兼容旧 import；新代码请用 `permissions::require_*` 系列
/// （平台超管 / 租户管理员 / 数据库管理员 / RBAC 权限）。详见 `auth.rs::Claims` 文档。
///
/// **注意**：本判定永远不要直接挂到生产路由——`claims.role` 在 admin_update_user
/// 里已经不再随 is_superadmin 联动，靠它做权限决定会有逻辑漏洞。
#[deprecated(note = "用 permissions::require_platform_superadmin / require_tenant_admin 代替")]
pub fn has_role(claims: &Claims, required_role: &str) -> bool {
    claims.role == required_role || claims.role == "admin"
}

/// 仅超级管理员可访问的中间件
///
/// 必须串接在 `auth_middleware` 之后，依赖请求扩展中已注入的 `Claims`。
/// 用于保护那些直接操作底层数据库 / schema / 平台配置的危险接口。
pub async fn require_superadmin_middleware(
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let claims = req
        .extensions()
        .get::<Claims>()
        .ok_or_else(|| AppError::Unauthorized("未认证".to_string()))?;

    if !claims.is_superadmin {
        return Err(AppError::Forbidden(
            "该接口仅平台超级管理员可访问".to_string(),
        ));
    }

    Ok(next.run(req).await)
}

/// **已废弃**：基于 `claims.role` 的角色中间件工厂。
/// 保留是为了不破坏外部调用，但 `main.rs` 已经不再挂载它。
#[deprecated(note = "用 permissions::TenantContext / require_tenant_admin 代替")]
#[allow(deprecated)]
pub fn require_role(
    required_role: &'static str,
) -> impl Fn(Request, Next) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Response, AppError>> + Send>,
> + Clone {
    move |req: Request, next: Next| {
        Box::pin(async move {
            let claims = req
                .extensions()
                .get::<Claims>()
                .ok_or_else(|| AppError::Unauthorized("未认证".to_string()))?;

            if !has_role(claims, required_role) {
                return Err(AppError::Forbidden(format!(
                    "需要 {} 角色权限",
                    required_role
                )));
            }

            Ok(next.run(req).await)
        })
    }
}

/// 标记旧版 `/api/:schema/:table` 路由族的弃用中间件。
///
/// 背景：项目里有两套行级 CRUD 路由：
///   - 旧：`/api/:schema/:table`         → 中间件链 `auth + require_superadmin + dynamic_db`
///     语义：超管直连数据库，**故意旁路 RBAC**，给运维/dashboard 表编辑器使用。
///   - 新：`/api/v1/:database_id/:schema/:table` → 中间件链 `auth + dynamic_db + rbac`
///     语义：业务 API，按 RBAC 行/列条件控制可见数据。
///
/// 旧路由本身**不绕过权限**（仍要超管），但语义被反复混淆。本中间件做两件事，
/// 不引入任何业务影响：
///   1. 在响应里注入 RFC 8594 的 `Deprecation` / `Link` / `Sunset` 头，
///      让 curl 脚本、外部集成方在 HTTP 层就能看到迁移信号。
///   2. 每次命中时打一条结构化 warn 日志（method/path/user_id/sub），
///      让运维能基于日志统计旧路由的真实调用情况，决定何时下线为 410。
///
/// 必须挂在 `auth_middleware` **之后**——这样我们才能拿到 `Claims`。
pub async fn deprecated_legacy_crud_middleware(
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let user_id = req
        .extensions()
        .get::<Claims>()
        .map(|c| c.sub)
        .unwrap_or(-1);

    // 跳过预检请求：OPTIONS 的 CORS 响应不要带 Deprecation，否则中间件可能让浏览器混淆。
    if method == Method::OPTIONS {
        return next.run(req).await;
    }

    tracing::warn!(
        target: "legacy_api",
        event = "legacy_crud_route_hit",
        method = %method,
        path = %path,
        user_id = user_id,
        "命中旧版 /api/:schema/:table 路由（仅超管，故意旁路 RBAC）；建议迁移到 /api/v1/{{database_id}}/{{schema}}/{{table}}"
    );

    let mut response = next.run(req).await;

    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("deprecation"),
        HeaderValue::from_static("true"),
    );
    headers.insert(
        HeaderName::from_static("link"),
        HeaderValue::from_static(
            "</api/v1/{database_id}/{schema}/{table}>; rel=\"successor-version\"",
        ),
    );
    // 没有正式的 sunset 日期（要等前端 tableAPI 迁移完才能 410）。
    // 这里写一个明显的占位提示，让上游集成方能看到弃用意向。
    headers.insert(
        HeaderName::from_static("x-deprecation-notice"),
        HeaderValue::from_static(
            "Legacy admin-direct CRUD route; will return 410 Gone after frontend migration.",
        ),
    );

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Claims;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::middleware::from_fn;
    use axum::routing::get;
    use axum::Router;
    use tower::util::ServiceExt;

    #[test]
    #[allow(deprecated)] // 测试覆盖 has_role 的兼容行为；该函数已标 deprecated。
    fn test_has_role() {
        let claims = Claims {
            sub: 123,
            email: "test@example.com".to_string(),
            role: "user".to_string(),
            is_superadmin: false,
            jti: "test-jti".to_string(),
            exp: 9999999999,
            iat: 0,
        };

        assert!(has_role(&claims, "user"));
        assert!(!has_role(&claims, "admin"));

        let admin_claims = Claims {
            role: "admin".to_string(),
            ..claims
        };

        assert!(has_role(&admin_claims, "user"));
        assert!(has_role(&admin_claims, "admin"));
    }

    /// 验证 `deprecated_legacy_crud_middleware` 给响应注入了正确的弃用头。
    ///
    /// 这是这次安全修复的回归测试——保证 RFC 8594 信号确实生效，
    /// 不会因为后续重构悄悄消失。
    #[tokio::test]
    async fn deprecated_middleware_adds_rfc_8594_headers() {
        let app = Router::new()
            .route("/api/:schema/:table", get(|| async { "ok" }))
            .layer(from_fn(deprecated_legacy_crud_middleware));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/public/users")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let headers = response.headers();
        assert_eq!(
            headers.get("deprecation").and_then(|v| v.to_str().ok()),
            Some("true"),
            "Deprecation header missing"
        );
        let link = headers
            .get("link")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            link.contains("successor-version") && link.contains("/api/v1/"),
            "Link successor-version missing or wrong: {}",
            link
        );
        assert!(
            headers
                .get("x-deprecation-notice")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .contains("410"),
            "Sunset notice missing or wrong"
        );
    }

    /// OPTIONS 预检请求不应被打弃用标签——避免污染 CORS 协商。
    #[tokio::test]
    async fn deprecated_middleware_skips_options_preflight() {
        let app = Router::new()
            .route(
                "/api/:schema/:table",
                axum::routing::any(|| async { "ok" }),
            )
            .layer(from_fn(deprecated_legacy_crud_middleware));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("OPTIONS")
                    .uri("/api/public/users")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(
            response.headers().get("deprecation").is_none(),
            "OPTIONS preflight should not be tagged deprecated"
        );
    }
}

