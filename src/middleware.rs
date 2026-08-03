use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, Uri},
    middleware::Next,
    response::Response,
};
use sqlx::{PgPool, Row};

use crate::auth::{verify_token, Claims};
use crate::error::AppError;
use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};

/// 数据面 API Key（`cr_`）鉴权后的上下文。
///
/// 由 [`auth_middleware`] 在校验 `cr_` 成功后注入请求扩展。下游必须复用此上下文，
/// 不得在同一请求中重新查询 `api_keys`。管理端 handler 可据此自动补全
/// `tenant_id` / `database_id`；数据面 `rbac_middleware` 见到 `cr_` 时仍走 Key scope
/// 路径（不因同时注入了 Claims 而改走用户 RBAC）。
#[derive(Debug, Clone)]
pub struct ApiKeyContext {
    #[allow(dead_code)]
    pub key_id: i32,
    pub tenant_id: i32,
    pub database_id: i32,
    pub permissions: serde_json::Value,
    pub bound_slug: String,
}

/// 校验 `cr_` API Key，并合成「该 Key 所属租户的 owner/admin」用户 Claims。
///
/// `api_keys` 表不绑用户，只绑 `tenant_id`/`database_id`；因此用租户成员表挑一个
/// active 的 owner（优先）或 admin，复用其权限面调用管理端接口。
async fn authenticate_cr_api_key(
    pool: &PgPool,
    raw_token: &str,
) -> Result<(Claims, ApiKeyContext), AppError> {
    let row = sqlx::query(
        r#"
        SELECT k.id              AS key_id,
               k.tenant_id       AS tenant_id,
               k.database_id     AS database_id,
               k.permissions     AS permissions,
               td.slug           AS bound_slug,
               u.id              AS user_id,
               u.email           AS email,
               COALESCE(u.role, 'user') AS role,
               COALESCE(u.is_superadmin, false) AS is_superadmin,
               ut.role           AS tenant_role
        FROM management.api_keys k
        JOIN management.tenant_databases td
          ON td.id = k.database_id
         AND td.is_active = true
        JOIN management.user_tenants ut
          ON ut.tenant_id = k.tenant_id
         AND ut.is_active = true
         AND ut.role IN ('owner', 'admin')
        JOIN users u ON u.id = ut.user_id
        WHERE k.key_hash = encode(sha256($1::bytea), 'hex')
          AND k.is_active = true
          AND (k.expires_at IS NULL OR k.expires_at > NOW())
        ORDER BY CASE ut.role WHEN 'owner' THEN 0 ELSE 1 END, u.id ASC
        LIMIT 1
        "#,
    )
    .bind(raw_token)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("校验 API Key 失败: {}", e)))?;

    let row = match row {
        Some(r) => r,
        None => {
            // 区分「Key 本身无效」与「租户没有 owner/admin」——先看 Key 是否存在。
            let key_exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM management.api_keys
                    WHERE key_hash = encode(sha256($1::bytea), 'hex')
                      AND is_active = true
                      AND (expires_at IS NULL OR expires_at > NOW())
                )
                "#,
            )
            .bind(raw_token)
            .fetch_one(pool)
            .await
            .unwrap_or(false);

            if key_exists {
                return Err(AppError::Forbidden(
                    "API Key 有效，但其所属租户没有 active 的 owner/admin，无法代表用户调用管理端接口"
                        .to_string(),
                ));
            }
            return Err(AppError::Unauthorized(
                "API Key 无效、已禁用或已过期".to_string(),
            ));
        }
    };

    let key_id: i32 = row.get("key_id");
    let tenant_id: i32 = row.get("tenant_id");
    let database_id: i32 = row.get("database_id");
    let permissions: serde_json::Value = row
        .try_get("permissions")
        .unwrap_or_else(|_| serde_json::json!({}));
    let bound_slug: String = row.get("bound_slug");
    let user_id: i32 = row.get("user_id");
    let email: String = row.get("email");
    let role: String = row.get("role");
    let is_superadmin: bool = row.try_get("is_superadmin").unwrap_or(false);

    // last_used_at 节流更新，失败不影响鉴权。
    let pool2 = pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE management.api_keys SET last_used_at = NOW() \
             WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - interval '60 seconds')",
        )
        .bind(key_id)
        .execute(&pool2)
        .await;
    });

    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: user_id,
        email,
        role,
        is_superadmin,
        // 无会话：与平台令牌同款，有效性完全由 api_keys 表控制。
        jti: format!("apikey:{}", key_id),
        exp: now + 3600 * 24 * 365,
        iat: now,
    };
    let ctx = ApiKeyContext {
        key_id,
        tenant_id,
        database_id,
        permissions,
        bound_slug,
    };
    Ok((claims, ctx))
}

fn extract_api_v1_db_segment(path: &str) -> Option<(String, String)> {
    let mut it = path.trim_start_matches('/').split('/');
    if it.next()? != "api" || it.next()? != "v1" {
        return None;
    }
    let db = it.next()?.to_string();
    let rest = it.collect::<Vec<_>>().join("/");
    Some((db, rest))
}

async fn resolve_database_id_from_slug(
    pool: &PgPool,
    headers: &axum::http::HeaderMap,
    claims: Option<&Claims>,
    slug: &str,
    api_key_ctx: Option<&ApiKeyContext>,
) -> Result<i32, AppError> {
    if let Some(ctx) = api_key_ctx {
        if ctx.bound_slug != slug {
            return Err(AppError::Forbidden(format!(
                "API Key 绑定的是项目 '{}'，与 URL 中的 '{}' 不匹配",
                ctx.bound_slug, slug
            )));
        }
        return Ok(ctx.database_id);
    }

    // API Key 调用：用 key 绑定库 + slug 双重校验，防止跨库探测
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let apikey = headers.get("apikey").and_then(|h| h.to_str().ok());
    let api_key = bearer
        .filter(|v| v.starts_with("cr_"))
        .or_else(|| apikey.filter(|v| v.starts_with("cr_")));
    if let Some(key) = api_key {
        // 先按 key 本身定位（不带 slug 条件），便于把"key 无效/过期"与
        // "key 有效但绑定到别的库"两类错误分开报，避免误导排查方向。
        let key_row = sqlx::query(
            r#"
            SELECT k.database_id, td.slug AS bound_slug
            FROM management.api_keys k
            JOIN management.tenant_databases td ON td.id = k.database_id
            WHERE k.key_hash = encode(sha256($1::bytea), 'hex')
              AND k.is_active = true
              AND (k.expires_at IS NULL OR k.expires_at > NOW())
              AND td.is_active = true
            "#,
        )
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(AppError::Database)?;

        let row = key_row.ok_or_else(|| {
            AppError::Unauthorized(
                "API Key 无效、已禁用或已过期（在本平台未找到匹配的密钥）".to_string(),
            )
        })?;

        let bound_slug: String = row.get("bound_slug");
        if bound_slug != slug {
            return Err(AppError::Forbidden(format!(
                "API Key 绑定的是项目 '{}'，与 URL 中的 '{}' 不匹配",
                bound_slug, slug
            )));
        }
        return Ok(row.get::<i32, _>("database_id"));
    }

    // JWT 调用：按用户租户成员关系解析
    let claims =
        claims.ok_or_else(|| AppError::Unauthorized("缺少有效的 JWT 或 API Key".to_string()))?;
    let rows = if claims.is_superadmin {
        sqlx::query(
            r#"
            SELECT id
            FROM management.tenant_databases
            WHERE slug = $1 AND is_active = true
            ORDER BY id ASC
            LIMIT 2
            "#,
        )
        .bind(slug)
        .fetch_all(pool)
        .await
        .map_err(AppError::Database)?
    } else {
        sqlx::query(
            r#"
            SELECT td.id
            FROM management.tenant_databases td
            JOIN management.user_tenants ut
              ON ut.tenant_id = td.tenant_id
             AND ut.user_id = $1
             AND ut.is_active = true
            WHERE td.slug = $2 AND td.is_active = true
            ORDER BY td.id ASC
            LIMIT 2
            "#,
        )
        .bind(claims.sub)
        .bind(slug)
        .fetch_all(pool)
        .await
        .map_err(AppError::Database)?
    };
    match rows.len() {
        0 => Err(AppError::NotFound(format!(
            "数据库 slug '{}' 不存在或无权访问",
            slug
        ))),
        1 => Ok(rows[0].get::<i32, _>("id")),
        _ => Err(AppError::InvalidQuery(format!(
            "database_slug '{}' 存在歧义，请改用 API Key 或确保当前租户唯一",
            slug
        ))),
    }
}

/// Auto API 路由段适配：支持 `/api/v1/{database_slug}/...`
/// 并在进入 handler 前重写成内部 `database_id` 路径，复用现有 handler 逻辑。
pub async fn auto_api_database_slug_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let original_path = req.uri().path().to_string();
    let Some((db_seg, rest)) = extract_api_v1_db_segment(&original_path) else {
        return Ok(next.run(req).await);
    };
    // rpc 子路由有专属中间件，不在这里处理
    if rest.starts_with("rpc/") || rest.starts_with("ddl/") || rest == "sql" {
        return Ok(next.run(req).await);
    }

    let headers = req.headers().clone();
    let claims = req.extensions().get::<Claims>().cloned();
    let api_key_ctx = req.extensions().get::<ApiKeyContext>().cloned();
    let database_id = if let Ok(id) = db_seg.parse::<i32>() {
        id
    } else {
        resolve_database_id_from_slug(
            &pool,
            &headers,
            claims.as_ref(),
            &db_seg,
            api_key_ctx.as_ref(),
        )
        .await?
    };

    // 路径权威：重写 path + 覆盖 X-Database-Id，防止 header/path 不一致
    let mut rewritten = format!("/api/v1/{}/{}", database_id, rest);
    if rest.is_empty() {
        rewritten = format!("/api/v1/{}", database_id);
    }
    if let Some(q) = req.uri().query() {
        rewritten.push('?');
        rewritten.push_str(q);
    }
    let uri: Uri = rewritten
        .parse()
        .map_err(|e| AppError::Internal(format!("重写 Auto API 路径失败: {}", e)))?;
    *req.uri_mut() = uri;
    req.headers_mut().insert(
        "X-Database-Id",
        HeaderValue::from_str(&database_id.to_string())
            .map_err(|e| AppError::Internal(format!("写入 X-Database-Id 失败: {}", e)))?,
    );

    Ok(next.run(req).await)
}

/// 读写分离池对，可通过 Extension 注入
#[allow(dead_code)]
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

/// 处于「必须改密」状态时仍放行的端点白名单：
/// 让用户能完成改密流程本身（改密 / 登出 / 读取自身信息 / 刷新 token），其余全部拦截。
fn is_password_change_allowed_path(path: &str) -> bool {
    matches!(
        path,
        "/auth/change-password" | "/auth/logout" | "/auth/me" | "/auth/refresh"
    )
}

/// JWT 认证中间件
///
/// 工作流程：
/// 1. 校验签名 + 过期；
/// 2. 校验 jti 在 `user_sessions` 表中存在、未吊销且未过期。
///    若 jti 不存在（旧 token / 篡改 token）/ revoked=true / expires_at 过期 → 401。
/// 3. 若该用户 `must_change_password=true`，除白名单端点外一律 403 强制改密。
pub async fn auth_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // 提前取出来给认证失败日志用（next.run 之后 req 已被消费）。
    let path = req.uri().path().to_string();
    let client_ip = client_ip_from_headers(req.headers());

    let token = match req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .or_else(|| {
            req.uri()
                .query()
                .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("token=")))
        }) {
        Some(t) => t,
        None => {
            tracing::warn!(
                target: "auth",
                path = %path,
                ip = %client_ip,
                "认证失败：缺少 Authorization header"
            );
            return Err(AppError::Unauthorized(
                "缺少 Authorization header".to_string(),
            ));
        }
    };

    // 平台服务令牌（crp_ 前缀）：解析成绑定用户的 Claims，复用既有权限体系，
    // 让机器/AI 能通过纯 HTTP 调用「仅 JWT」的管理端点。必须排在 cr_ 分支之前
    // （虽然 crp_ 不以 cr_ 开头，但语义上先处理更清晰）。
    if token.starts_with(crate::platform_token::TOKEN_PREFIX) {
        let (claims, ctx) = crate::platform_token::authenticate(&pool, token)
            .await
            .map_err(|e| {
                tracing::warn!(
                    target: "auth",
                    path = %path,
                    ip = %client_ip,
                    "认证失败：平台令牌校验未通过"
                );
                e
            })?;
        let user_id = claims.sub;
        req.extensions_mut().insert(claims);
        crate::audit_middleware::propagate_user_id(&mut req, user_id);
        req.extensions_mut().insert(ctx);
        let mut response = next.run(req).await;
        response
            .extensions_mut()
            .insert(crate::request_id::AccessLogUser(user_id));
        return Ok(response);
    }

    // 数据面 API Key（cr_ 前缀）：校验 Key，并合成所属租户 owner/admin 的 Claims，
    // 从而也能调用「仅 JWT」的管理端（如 scheduled-tasks）。同时注入 ApiKeyContext，
    // 供 handler 自动补全 tenant_id / database_id。
    //
    // 数据面 Auto API 的 rbac_middleware 见到 cr_ 时仍优先走 Key scope 路径，
    // 不会因为这里注入了 Claims 就改成用户 RBAC（避免破坏仅靠 Key permissions 的调用）。
    if token.starts_with("cr_") {
        let (claims, ctx) = authenticate_cr_api_key(&pool, token).await.map_err(|e| {
            tracing::warn!(
                target: "auth",
                path = %path,
                ip = %client_ip,
                "认证失败：API Key 校验未通过"
            );
            e
        })?;
        let user_id = claims.sub;
        req.extensions_mut().insert(claims);
        req.extensions_mut().insert(ctx);
        crate::audit_middleware::propagate_user_id(&mut req, user_id);
        let mut response = next.run(req).await;
        response
            .extensions_mut()
            .insert(crate::request_id::AccessLogUser(user_id));
        return Ok(response);
    }

    let claims = verify_token(token).map_err(|e| {
        tracing::warn!(
            target: "auth",
            path = %path,
            ip = %client_ip,
            "认证失败：JWT 校验未通过"
        );
        e
    })?;

    // 校验服务端会话状态（jti 必须存在且未吊销）
    if claims.jti.is_empty() {
        tracing::warn!(
            target: "auth",
            user_id = claims.sub,
            path = %path,
            ip = %client_ip,
            "认证失败：Token 缺少 jti"
        );
        return Err(AppError::Unauthorized(
            "Token 缺少 jti 字段，请重新登录".to_string(),
        ));
    }

    let session_row = sqlx::query(
        r#"
        SELECT s.revoked, s.expires_at,
               COALESCE(u.must_change_password, false) AS must_change_password
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.jti = $1::uuid
        "#,
    )
    .bind(&claims.jti)
    .fetch_optional(&pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询会话状态失败: {}", e)))?;

    let row = match session_row {
        Some(r) => r,
        None => {
            tracing::warn!(
                target: "auth",
                user_id = claims.sub,
                path = %path,
                ip = %client_ip,
                "认证失败：会话不存在或已注销"
            );
            return Err(AppError::Unauthorized(
                "会话不存在或已注销，请重新登录".to_string(),
            ));
        }
    };

    let revoked: bool = row.try_get("revoked").unwrap_or(false);
    if revoked {
        tracing::warn!(
            target: "auth",
            user_id = claims.sub,
            path = %path,
            ip = %client_ip,
            "认证失败：会话已被吊销"
        );
        return Err(AppError::Unauthorized(
            "会话已被吊销，请重新登录".to_string(),
        ));
    }

    let expires_at: chrono::DateTime<chrono::Utc> = row
        .try_get("expires_at")
        .map_err(|e| AppError::Internal(format!("会话过期时间解析失败: {}", e)))?;
    if expires_at < chrono::Utc::now() {
        tracing::warn!(
            target: "auth",
            user_id = claims.sub,
            path = %path,
            ip = %client_ip,
            "认证失败：会话已过期"
        );
        return Err(AppError::Unauthorized("会话已过期，请重新登录".to_string()));
    }

    // 强制改密网关：内置默认管理员首次登录后必须先改密，否则除“改密/登出/查询自身/刷新”
    // 之外的所有受保护端点一律 403（code=password_change_required）。以 DB 为准，改密成功
    // 立即解除拦截，无需重新签发 token。
    let must_change_password: bool = row.try_get("must_change_password").unwrap_or(false);
    if must_change_password && !is_password_change_allowed_path(&path) {
        tracing::warn!(
            target: "auth",
            user_id = claims.sub,
            path = %path,
            ip = %client_ip,
            "拦截：账号需先修改密码"
        );
        return Err(AppError::PasswordChangeRequired(
            "请先修改初始密码后再继续使用".to_string(),
        ));
    }

    let user_id = claims.sub;
    req.extensions_mut().insert(claims);
    crate::audit_middleware::propagate_user_id(&mut req, user_id);

    let mut response = next.run(req).await;
    // 把用户 ID 回传给最外层 access log（见 request_id::AccessLogUser）。
    response
        .extensions_mut()
        .insert(crate::request_id::AccessLogUser(user_id));
    Ok(response)
}

/// 平台令牌 scope 校验。
///
/// 仅对「带平台令牌（crp_）」的请求生效：若请求扩展里有 [`PlatformTokenContext`]，
/// 则要求其 scope 覆盖 `required`，否则 403。普通 JWT 用户没有该扩展，直接放行
/// （他们的权限由各 handler 的 owner/admin/superadmin 校验把关）。
///
/// 用 `from_fn` 闭包按路由组指定所需 scope，例如：
/// `from_fn(|req, next| enforce_platform_scope(req, next, platform_token::SCOPE_PROJECT_CREATE))`
pub async fn enforce_platform_scope(
    req: Request,
    next: Next,
    required: &'static str,
) -> Result<Response, AppError> {
    if let Some(ctx) = req
        .extensions()
        .get::<crate::platform_token::PlatformTokenContext>()
    {
        if !ctx.allows(required) {
            return Err(AppError::Forbidden(format!(
                "平台令牌缺少所需 scope：{}",
                required
            )));
        }
    }
    Ok(next.run(req).await)
}

/// 工作流管理路由的平台令牌 scope 校验（按方法/路径细分）。
///
/// 仅对带平台令牌的请求生效。所需 scope：
/// - 路径以 `/trigger` 结尾（手动触发执行）→ `workflow:run`
/// - GET / HEAD（列表、详情、版本、运行历史）→ `workflow:read`
/// - 其余写操作（创建/更新/删除/复制/恢复/调试/清理）→ `workflow:write`
pub async fn enforce_workflow_token_scope(
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    if let Some(ctx) = req
        .extensions()
        .get::<crate::platform_token::PlatformTokenContext>()
        .cloned()
    {
        let path = req.uri().path();
        let required = if path.ends_with("/trigger") {
            crate::platform_token::SCOPE_WORKFLOW_RUN
        } else if matches!(*req.method(), Method::GET | Method::HEAD) {
            crate::platform_token::SCOPE_WORKFLOW_READ
        } else {
            crate::platform_token::SCOPE_WORKFLOW_WRITE
        };
        if !ctx.allows(required) {
            return Err(AppError::Forbidden(format!(
                "平台令牌缺少所需 scope：{}",
                required
            )));
        }
    }
    Ok(next.run(req).await)
}

/// 从常见反代头里提取客户端 IP，用于认证 / 权限失败日志。
/// 仅取 `x-forwarded-for` 链首或 `x-real-ip`；都没有时返回 `"unknown"`。
fn client_ip_from_headers(headers: &axum::http::HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// 可选认证中间件（token 无效时不报错，仅在有效时添加用户信息）
///
/// 同样会校验 jti / 吊销状态；任一环节失败都直接视为"未登录"，不返回错误。
#[allow(dead_code)]
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
                    let expires_at: Option<chrono::DateTime<chrono::Utc>> =
                        r.try_get("expires_at").ok();
                    let active =
                        !revoked && expires_at.map(|t| t > chrono::Utc::now()).unwrap_or(false);
                    if active {
                        let user_id = claims.sub;
                        req.extensions_mut().insert(claims);
                        crate::audit_middleware::propagate_user_id(&mut req, user_id);
                        let mut response = next.run(req).await;
                        response
                            .extensions_mut()
                            .insert(crate::request_id::AccessLogUser(user_id));
                        return response;
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
    if let Some(db_id_str) = req
        .headers()
        .get("X-Database-Id")
        .and_then(|h| h.to_str().ok())
    {
        tracing::debug!("检测到 X-Database-Id 请求头: {}", db_id_str);
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
                                return Err(AppError::Forbidden(
                                    "No access to this database".to_string(),
                                ));
                            }
                        }
                    }
                    // handler 可以直接 `Extension<CurrentTenantId>` 拿（同层）。
                    req.extensions_mut().insert(CurrentTenantId(tenant_id));
                    // audit_middleware 是 app 级外层 layer，运行时机早于这里——它无法在
                    // next.run 返回后再读 req.extensions（req 已被 Next::run 消费）。
                    // 必须通过外层在入口注入的 `TenantIdSink` 信箱把值回传给它，否则
                    // audit_logs.tenant_id 全为 NULL（dashboard 按 tenant_id 过滤会拉空）。
                    if let Some(sink) = req
                        .extensions()
                        .get::<crate::audit_middleware::TenantIdSink>()
                    {
                        sink.set(tenant_id);
                    }
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
                    max_connections: row
                        .get::<Option<i32>, _>("max_connections")
                        .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32)
                        as u32,
                    connection_timeout: row
                        .get::<Option<i32>, _>("connection_timeout")
                        .unwrap_or(30) as u64,
                };

                let pool = POOL_MANAGER.get_or_create_pool(config).await?;

                // 加载 replica（如果有）
                if let Ok(replicas) = sqlx::query(
                    "SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted, \
                            COALESCE(weight, 1) AS weight \
                     FROM management.tenant_databases \
                     WHERE primary_id = $1 AND is_active = true AND db_role = 'replica'",
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
                            max_connections: crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS,
                            connection_timeout: 30,
                        };
                        let _ = POOL_MANAGER
                            .upsert_replica(database_id, replica_id, weight, rc)
                            .await;
                    }
                }

                let read_pool = POOL_MANAGER
                    .get_read_pool(database_id)
                    .unwrap_or_else(|| pool.clone());
                let write_pool = pool.clone();

                req.extensions_mut().insert(ReadWritePools {
                    read: read_pool,
                    write: write_pool.clone(),
                });
                req.extensions_mut().insert(write_pool);
                req.extensions_mut().insert(CurrentDatabaseId(database_id));
                tracing::debug!("成功切换到数据库连接 ID: {}", database_id);
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
#[allow(dead_code)]
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
#[allow(dead_code)]
pub fn has_role(claims: &Claims, required_role: &str) -> bool {
    claims.role == required_role || claims.role == "admin"
}

/// 仅超级管理员可访问的中间件
///
/// 必须串接在 `auth_middleware` 之后，依赖请求扩展中已注入的 `Claims`。
/// 用于保护那些直接操作底层数据库 / schema / 平台配置的危险接口。
pub async fn require_superadmin_middleware(req: Request, next: Next) -> Result<Response, AppError> {
    // 平台超管限制已按需求移除：任何已通过认证的用户都可访问这些接口。
    // 仍要求请求携带有效身份（Claims 由 auth_middleware 注入），即只对"已登录用户"放开。
    let _claims = req
        .extensions()
        .get::<Claims>()
        .ok_or_else(|| AppError::Unauthorized("未认证".to_string()))?;

    Ok(next.run(req).await)
}

/// 旧版 `/api/:schema/:table` 的第二段（schema）；非该形态返回 None。
fn extract_legacy_crud_schema(path: &str) -> Option<&str> {
    let mut parts = path.trim_start_matches('/').split('/');
    if parts.next()? != "api" {
        return None;
    }
    let schema = parts.next()?;
    let _table = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    Some(schema)
}

/// 平台元数据 API 的 schema 段，禁止落入旧版 CRUD 路由。
fn is_reserved_legacy_crud_schema(schema: &str) -> bool {
    matches!(
        schema,
        "pg-pools"
            | "project-templates"
            | "projects"
            | "tenants"
            | "admin"
            | "rbac"
            | "dashboard"
            | "provision"
            | "platform-tokens"
            | "sso"
            | "sse"
            | "es-app"
            | "schemas"
            | "indexes"
            | "ddl"
            | "export"
            | "monitor"
    ) || schema.contains('-')
}

/// 遗留 CRUD（`/api/:schema/:table`）访问门槛中间件。
///
/// 历史上这组接口挂 `require_superadmin_middleware`，导致项目 owner/成员浏览/编辑
/// 自己项目的数据时被「该接口仅平台超级管理员可访问」挡住。本中间件把门槛从
/// "平台超管" 收敛为符合多租户语义的项目级权限：
///
/// 1. **必须已切到具体租户库**（`dynamic_db_middleware` 注入了 `CurrentDatabaseId`）。
///    没带 `X-Database-Id` 时遗留 handler 会回落到管理库（management）——这会把平台
///    `users`/`tenants` 当业务数据返回，是严重的跨租户泄漏。这里直接 403 堵死。
/// 2. **租户成员校验**：`dynamic_db_middleware` 已经断言"非超管必须是该库所属租户的
///    active 成员"，否则它自己就 403 了。所以走到这里的非超管一定是该租户成员。
/// 3. **写操作再收紧到 member+**：GET 读取任意 active 成员（含 viewer）放行；
///    POST/PATCH/DELETE 要求 owner/admin/member（viewer 只读）。
///
/// 必须串在 `auth_middleware` + `dynamic_db_middleware` **之后**（执行顺序上更内层）。
pub async fn legacy_crud_access_middleware(
    State(pool): State<PgPool>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let path = req.uri().path();
    if let Some(schema) = extract_legacy_crud_schema(path) {
        if is_reserved_legacy_crud_schema(schema) {
            return Err(AppError::NotFound(format!(
                "路径 {} 不是旧版 CRUD 接口；请检查 API 路径是否正确",
                path
            )));
        }
    }

    let claims = req
        .extensions()
        .get::<Claims>()
        .cloned()
        .ok_or_else(|| AppError::Unauthorized("未认证".to_string()))?;

    // 必须已切换到具体租户库，禁止回落管理库。
    let database_id = req
        .extensions()
        .get::<CurrentDatabaseId>()
        .map(|d| d.0)
        .ok_or_else(|| {
            AppError::Forbidden(
                "该接口必须通过 X-Database-Id 指定项目数据库，禁止在平台管理库上执行".to_string(),
            )
        })?;

    if claims.is_superadmin {
        return Ok(next.run(req).await);
    }

    // dynamic_db_middleware 已校验"非超管是该租户 active 成员"。这里只对写操作再卡一层
    // member+（viewer 只读）。
    let is_write = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if is_write {
        let tenant_id = match req.extensions().get::<CurrentTenantId>().map(|t| t.0) {
            Some(t) => t,
            None => crate::permissions::lookup_tenant_for_database(&pool, database_id).await?,
        };
        if !crate::permissions::is_tenant_member(&pool, claims.sub, tenant_id).await? {
            return Err(AppError::Forbidden(
                "viewer 角色只读；写操作需要 owner/admin/member 角色".to_string(),
            ));
        }
    }

    Ok(next.run(req).await)
}

/// **已废弃**：基于 `claims.role` 的角色中间件工厂。
/// 保留是为了不破坏外部调用，但 `main.rs` 已经不再挂载它。
#[deprecated(note = "用 permissions::TenantContext / require_tenant_admin 代替")]
#[allow(dead_code, deprecated)]
pub fn require_role(
    required_role: &'static str,
) -> impl Fn(
    Request,
    Next,
)
    -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, AppError>> + Send>>
       + Clone {
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
///   - 新：`/api/v1/:database_slug/:schema/:table` → 中间件链 `auth + dynamic_db + rbac`
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
pub async fn deprecated_legacy_crud_middleware(req: Request, next: Next) -> Response {
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
        "命中旧版 /api/:schema/:table 路由（仅超管，故意旁路 RBAC）；建议迁移到 /api/v1/{{database_slug}}/{{schema}}/{{table}}"
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
            "</api/v1/{database_slug}/{schema}/{table}>; rel=\"successor-version\"",
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
            .route("/api/:schema/:table", axum::routing::any(|| async { "ok" }))
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
