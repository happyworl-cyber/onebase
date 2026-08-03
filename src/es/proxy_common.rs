//! ES 代理 / 高层 API 共用的小工具集。
//!
//! 两个出口：
//!   - `proxy_handler`（透传 `/api/es/*es_path`）
//!   - `app_handlers`（高层业务 API `/api/es-app/*`）
//!
//! 共用的部分：
//!   1. 全局 `reqwest::Client`（按 verify_tls 缓存两份）
//!   2. token → connection 的单 SELECT JOIN + 状态检查
//!   3. method / index allowlist 校验（path_denylist 在这一层留给透传用，高层 API
//!      不暴露任意 path 所以可以只跑前两层）
//!   4. 上游 URL 拼接
//!   5. fire-and-forget 的 `last_used_at` / `use_count` 统计更新
//!
//! 故意拆出来：把"鉴权 + 客户端 + 统计"这些与 ES 业务无关的运维细节集中在一处，
//! 后面再加新 endpoint（例如 SQL passthrough、async search 包装）不用再抄一遍。

use std::sync::OnceLock;

use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};

use crate::error::AppError;
use crate::es::auth as es_auth;
use crate::es::models::EsConnection;

/// `/api/v1/:database_slug/es*` 路由注入：校验 ES token 所属租户与 slug 对应项目一致。
#[derive(Clone, Debug)]
pub struct EsTenantScope {
    pub tenant_id: i32,
}

/// 仅按 key 取 `database_slug` 的路径参数容器。
///
/// 中间件挂在 `/api/v1/:database_slug/es*` 这类嵌套路由上，运行时拿得到的不止
/// `database_slug` 一个参数（还有内层的 `:index` / `*es_path`）。用具名结构体按
/// key 解析可忽略多余参数，避免 `Path<String>` 因参数个数不匹配报
/// "Wrong number of path arguments"。
#[derive(Debug, serde::Deserialize)]
pub struct DatabaseSlugPath {
    pub database_slug: String,
}

/// 挂在 slug 前缀 ES 路由上的中间件：解析 `database_slug` → tenant_id 写入 extensions。
pub async fn es_tenant_scope_middleware(
    axum::extract::State(pool): axum::extract::State<PgPool>,
    axum::extract::Path(DatabaseSlugPath { database_slug }): axum::extract::Path<DatabaseSlugPath>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let tenant_id = resolve_tenant_id_by_database_slug(&pool, &database_slug).await?;
    req.extensions_mut().insert(EsTenantScope { tenant_id });
    Ok(next.run(req).await)
}

async fn resolve_tenant_id_by_database_slug(
    pool: &PgPool,
    database_slug: &str,
) -> Result<i32, AppError> {
    if let Ok(id) = database_slug.parse::<i32>() {
        let tenant_id: Option<i32> = sqlx::query_scalar(
            "SELECT tenant_id FROM management.tenant_databases WHERE id = $1 AND is_active = true",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::Internal(format!("查询 database 失败: {e}")))?;
        return tenant_id.ok_or_else(|| {
            AppError::NotFound(format!("数据库 '{}' 不存在或未启用", database_slug))
        });
    }

    let tenant_ids: Vec<i32> = sqlx::query_scalar(
        "SELECT tenant_id FROM management.tenant_databases \
         WHERE slug = $1 AND is_active = true \
         ORDER BY tenant_id ASC LIMIT 2",
    )
    .bind(database_slug)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 database slug 失败: {e}")))?;

    match tenant_ids.len() {
        0 => Err(AppError::NotFound(format!(
            "项目 slug '{}' 不存在或未启用",
            database_slug
        ))),
        1 => Ok(tenant_ids[0]),
        _ => Err(AppError::InvalidQuery(format!(
            "项目 slug '{}' 存在歧义",
            database_slug
        ))),
    }
}

// ── reqwest client 缓存 ─────────────────────────────────────────────────

/// 全局 `reqwest::Client`（TLS 严格 / TLS 宽松 两份），初始化一次。
///
/// 不在 client 上设全局 timeout —— 我们在 per-request `tokio::time::timeout` 控制，
/// 按 connection 维度差异化。`reqwest::Client` 内部就是 `Arc`，clone 廉价；多线程
/// 并发 send 安全。
struct ProxyClients {
    tls_strict: reqwest::Client,
    tls_lax: reqwest::Client,
}

static PROXY_CLIENTS: OnceLock<ProxyClients> = OnceLock::new();

fn proxy_clients() -> &'static ProxyClients {
    PROXY_CLIENTS.get_or_init(|| {
        let strict = reqwest::Client::builder()
            .build()
            .expect("构造严格 TLS 的 reqwest client 失败（链接/系统证书异常？）");
        let lax = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .expect("构造宽松 TLS 的 reqwest client 失败");
        ProxyClients {
            tls_strict: strict,
            tls_lax: lax,
        }
    })
}

/// 按 `verify_tls` 取对应 client。
pub(crate) fn pick_client(verify_tls: bool) -> &'static reqwest::Client {
    let clients = proxy_clients();
    if verify_tls {
        &clients.tls_strict
    } else {
        &clients.tls_lax
    }
}

// ── token JOIN connection ──────────────────────────────────────────────

#[derive(FromRow)]
struct TokenJoinConnectionRow {
    token_id: i64,
    allowed_methods: Vec<String>,
    index_allowlist: Vec<String>,
    path_denylist: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
    is_active: bool,
    revoked_at: Option<DateTime<Utc>>,
    c_id: i64,
    c_tenant_id: i32,
    c_connection_name: String,
    c_base_url: String,
    c_auth_type: String,
    c_auth_credential_enc: Option<String>,
    c_verify_tls: bool,
    c_default_timeout_secs: i32,
    c_is_active: bool,
    c_created_by: i32,
    c_created_at: DateTime<Utc>,
    c_updated_at: DateTime<Utc>,
}

/// 一次成功解析后的 token + connection 视图，调用方拿到它就够发上游请求了。
pub(crate) struct ResolvedToken {
    pub token_id: i64,
    pub allowed_methods: Vec<String>,
    pub index_allowlist: Vec<String>,
    pub path_denylist: Vec<String>,
    pub connection: EsConnection,
    /// 已经 clamp 到 [1, 600]s 的上游超时。
    pub timeout_secs: u64,
}

/// 从 headers 取 token，查 DB，把 token + connection 一次性返回。
///
/// 失败返回的 `AppError` 已经分好类（401 / 403 / 503），调用方原样 `?` 即可。
pub(crate) async fn resolve_token(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<ResolvedToken, AppError> {
    let token_plain = es_auth::extract_token(headers).ok_or_else(|| {
        AppError::Unauthorized(
            "缺少 ES 代理 token；请用 `Authorization: ApiKey cres_es_xxx`".to_string(),
        )
    })?;
    let token_hash = es_auth::hash_token(&token_plain);

    // 单 SELECT JOIN 把 token + connection 一次性拿全。partial index 命中
    // `is_active AND revoked_at IS NULL`；命中后还在应用层再校一次 is_active 防
    // "查询后到下一次同行被撤销"的极窄窗口（不会更新结果，但日志能讲清楚）。
    let row = sqlx::query_as::<_, TokenJoinConnectionRow>(
        "SELECT \
            t.id              AS token_id, \
            t.allowed_methods AS allowed_methods, \
            t.index_allowlist AS index_allowlist, \
            t.path_denylist   AS path_denylist, \
            t.expires_at      AS expires_at, \
            t.is_active       AS is_active, \
            t.revoked_at      AS revoked_at, \
            c.id                   AS c_id, \
            c.tenant_id            AS c_tenant_id, \
            c.connection_name      AS c_connection_name, \
            c.base_url             AS c_base_url, \
            c.auth_type            AS c_auth_type, \
            c.auth_credential_enc  AS c_auth_credential_enc, \
            c.verify_tls           AS c_verify_tls, \
            c.default_timeout_secs AS c_default_timeout_secs, \
            c.is_active            AS c_is_active, \
            c.created_by           AS c_created_by, \
            c.created_at           AS c_created_at, \
            c.updated_at           AS c_updated_at \
         FROM management.es_access_tokens t \
         JOIN management.es_connections c ON c.id = t.connection_id \
         WHERE t.token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::Internal(format!("查询 ES token 失败: {e}")))?
    .ok_or_else(|| {
        // 故障定位用：DB 里没匹配上意味着以下其一发生：
        //   - 调用方拿的明文 token 已不在表里（被删除 / 撤销 / 整体回滚）
        //   - 持有 token 的连接被删了——FK ON DELETE CASCADE 会带掉所有 token
        //   - 表/库被还原到了不包含该 token_hash 的快照
        // 只记 token_hash 的前 12 位（防止整段 hash 进日志被滥用），加上明文前缀
        // 段（与 UI 列表里展示的 token_prefix 同款），运维直接能对上 UI 的哪一行
        // 是"曾经存在但现在已没了"。
        let hash_head: String = token_hash.chars().take(12).collect();
        let token_head = es_auth::token_prefix(&token_plain);
        tracing::warn!(
            "ES proxy: token_hash 在 management.es_access_tokens 无匹配 \
             (prefix={}, hash_head={}…)。可能原因：token 已撤销 / 重建，或所属连接被删（FK CASCADE）。\
             排查：SELECT id, name, token_prefix, is_active, revoked_at, last_used_at, use_count \
             FROM management.es_access_tokens WHERE token_prefix = '{}';",
            token_head,
            hash_head,
            token_head,
        );
        AppError::Unauthorized("ES token 无效".to_string())
    })?;

    if !row.is_active || row.revoked_at.is_some() {
        return Err(AppError::Unauthorized("ES token 已停用或撤销".to_string()));
    }
    if let Some(exp) = row.expires_at {
        if exp <= Utc::now() {
            return Err(AppError::Unauthorized("ES token 已过期".to_string()));
        }
    }
    if !row.c_is_active {
        return Err(AppError::ServiceUnavailable("ES 连接已停用".to_string()));
    }

    let timeout_secs = row.c_default_timeout_secs.clamp(1, 600) as u64;
    let connection = EsConnection {
        id: row.c_id,
        tenant_id: row.c_tenant_id,
        connection_name: row.c_connection_name,
        base_url: row.c_base_url,
        auth_type: row.c_auth_type,
        auth_credential_enc: row.c_auth_credential_enc,
        verify_tls: row.c_verify_tls,
        default_timeout_secs: row.c_default_timeout_secs,
        is_active: row.c_is_active,
        created_by: row.c_created_by,
        created_at: row.c_created_at,
        updated_at: row.c_updated_at,
    };
    Ok(ResolvedToken {
        token_id: row.token_id,
        allowed_methods: row.allowed_methods,
        index_allowlist: row.index_allowlist,
        path_denylist: row.path_denylist,
        connection,
        timeout_secs,
    })
}

/// 解析 ES token；若请求来自 `/api/v1/:database_slug/es*`，额外校验 token 租户与 slug 一致。
pub(crate) async fn resolve_token_for_request(
    pool: &PgPool,
    headers: &HeaderMap,
    scope: Option<axum::Extension<EsTenantScope>>,
) -> Result<ResolvedToken, AppError> {
    let token = resolve_token(pool, headers).await?;
    if let Some(axum::Extension(scope)) = scope {
        if token.connection.tenant_id != scope.tenant_id {
            return Err(AppError::Forbidden(
                "ES 代理 token 与 URL 中的项目 slug 不匹配".to_string(),
            ));
        }
    }
    Ok(token)
}

/// 对透传场景做三层校验（method / path_denylist / index_allowlist）。
///
/// `path` 是去掉 `/api/es` 前缀的 ES 原生路径（含开头 `/`）。
pub(crate) fn enforce_full_access(
    token: &ResolvedToken,
    method: &str,
    path: &str,
) -> Result<(), AppError> {
    let decision = es_auth::check_access(
        method,
        path,
        &token.allowed_methods,
        &token.path_denylist,
        &token.index_allowlist,
    );
    match decision {
        es_auth::AccessDecision::Allowed => Ok(()),
        // 用 403 而非 401：token 本身合法但权限不够（与"鉴权失败"区分开，便于客户端 retry）。
        es_auth::AccessDecision::Denied(reason) => {
            Err(AppError::Forbidden(format!("ES 代理拒绝请求：{}", reason)))
        }
    }
}

/// 对高层 API 做"method + 单 index"校验。
///
/// 不跑 path_denylist：高层 API 的上游 path 由代理自己构造，不存在 path 注入面。
/// `index` 必须是一个明确的单 index 名（不允许逗号 / `_all` / `*`，避免无意中越权）。
pub(crate) fn enforce_app_access(
    token: &ResolvedToken,
    method: &str,
    index: &str,
) -> Result<(), AppError> {
    // method
    let method_upper = method.to_uppercase();
    if !token
        .allowed_methods
        .iter()
        .any(|m| m.eq_ignore_ascii_case(&method_upper))
    {
        return Err(AppError::Forbidden(format!(
            "method {} 不在 token 允许列表 {:?}",
            method_upper, token.allowed_methods
        )));
    }

    // index 形态：禁止逗号 / 通配 / 空 / 以 `_` 开头（系统索引）
    if index.is_empty()
        || index.contains(',')
        || index.contains('*')
        || index.contains('?')
        || index.starts_with('_')
    {
        return Err(AppError::InvalidQuery(format!(
            "index `{}` 不合法：高层 API 只接受单个明确的 index 名（不支持逗号、通配或 `_` 开头）",
            index
        )));
    }

    // index allowlist（`*` 直接放行）
    if !token.index_allowlist.iter().any(|p| p == "*") {
        let ok = token
            .index_allowlist
            .iter()
            .any(|pat| es_auth::glob_match(pat, index));
        if !ok {
            return Err(AppError::Forbidden(format!(
                "index `{}` 不在 token 允许列表 {:?}",
                index, token.index_allowlist
            )));
        }
    }
    Ok(())
}

// ── 上游 URL 拼接 ──────────────────────────────────────────────────────

/// 拼上游 URL：`base_url`（去尾 `/`）+ `path`（含头 `/`）+ `?query`（可选）。
pub(crate) fn build_upstream_url(base_url: &str, path: &str, query: Option<&str>) -> String {
    let base = base_url.trim_end_matches('/');
    match query {
        Some(q) if !q.is_empty() => format!("{}{}?{}", base, path, q),
        _ => format!("{}{}", base, path),
    }
}

// ── token 使用统计（fire-and-forget） ──────────────────────────────────

/// 异步更新 `last_used_at` / `use_count`，失败只记日志不影响主流程。
///
/// 单独提出来是因为 request_id 是 task_local，不会跨 `tokio::spawn` 自动传递；
/// 这里手动 capture + scope，spawn 出去的日志才能拿到本次请求的 trace。
pub(crate) fn spawn_usage_update(pool: PgPool, token_id: i64) {
    let captured_req_id = crate::request_id::current();
    tokio::spawn(crate::request_id::scope_with(captured_req_id, async move {
        if let Err(e) = sqlx::query(
            "UPDATE management.es_access_tokens \
             SET last_used_at = NOW(), use_count = use_count + 1 \
             WHERE id = $1",
        )
        .bind(token_id)
        .execute(&pool)
        .await
        {
            tracing::warn!(
                "更新 es_access_token 统计失败 (token_id={}): {}",
                token_id,
                e
            );
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_token(methods: &[&str], indices: &[&str]) -> ResolvedToken {
        ResolvedToken {
            token_id: 1,
            allowed_methods: methods.iter().map(|s| s.to_string()).collect(),
            index_allowlist: indices.iter().map(|s| s.to_string()).collect(),
            path_denylist: vec![],
            connection: EsConnection {
                id: 1,
                tenant_id: 1,
                connection_name: "t".into(),
                base_url: "http://es:9200".into(),
                auth_type: "none".into(),
                auth_credential_enc: None,
                verify_tls: true,
                default_timeout_secs: 30,
                is_active: true,
                created_by: 1,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
            timeout_secs: 30,
        }
    }

    #[test]
    fn upstream_url_strips_trailing_slash() {
        assert_eq!(
            build_upstream_url("https://es.foo/", "/logs/_search", None),
            "https://es.foo/logs/_search"
        );
        assert_eq!(
            build_upstream_url("https://es.foo", "/logs/_search", Some("size=10")),
            "https://es.foo/logs/_search?size=10"
        );
        assert_eq!(
            build_upstream_url("https://es.foo", "/logs/_search", Some("")),
            "https://es.foo/logs/_search"
        );
    }

    #[test]
    fn enforce_app_access_method_and_index() {
        let tk = mk_token(&["GET", "POST"], &["orders", "logs-*"]);
        // ok
        enforce_app_access(&tk, "GET", "orders").unwrap();
        enforce_app_access(&tk, "post", "logs-2024").unwrap();
        // 方法不允许
        assert!(enforce_app_access(&tk, "DELETE", "orders").is_err());
        // index 不在白名单
        assert!(enforce_app_access(&tk, "GET", "audit").is_err());
        // index 通配 / 逗号 / `_` 前缀都拒
        assert!(enforce_app_access(&tk, "GET", "logs-*").is_err());
        assert!(enforce_app_access(&tk, "GET", "logs-1,logs-2").is_err());
        assert!(enforce_app_access(&tk, "GET", "_all").is_err());
        assert!(enforce_app_access(&tk, "GET", "").is_err());
    }

    #[test]
    fn enforce_app_access_star_allowlist() {
        let tk = mk_token(&["GET"], &["*"]);
        enforce_app_access(&tk, "GET", "anything").unwrap();
        enforce_app_access(&tk, "GET", "another-index").unwrap();
        // 仍然挡 `_` 前缀 / 逗号 / 通配（防越权）
        assert!(enforce_app_access(&tk, "GET", "_search").is_err());
        assert!(enforce_app_access(&tk, "GET", "a,b").is_err());
    }
}
