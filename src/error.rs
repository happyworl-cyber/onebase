use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// 应用错误类型
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Database(#[from] sqlx::Error),

    #[error("无效的查询参数: {0}")]
    InvalidQuery(String),

    #[error("无效的 JSON 数据: {0}")]
    InvalidJson(#[from] serde_json::Error),

    #[error("未授权: {0}")]
    Unauthorized(String),

    #[error("禁止访问: {0}")]
    Forbidden(String),

    #[error("需要修改密码: {0}")]
    PasswordChangeRequired(String),

    #[error("资源未找到: {0}")]
    NotFound(String),

    #[error("内部错误: {0}")]
    Internal(String),

    #[error("请求过多: {0}")]
    TooManyRequests(String),

    #[error("服务不可用: {0}")]
    ServiceUnavailable(String),
}

/// 客户端可读的错误码——稳定字符串，用于前端分支判断 / 监控告警分组。
///
/// 不暴露 schema 细节（表名 / 列名 / SQL），只给一个枚举值；具体 root cause
/// 仍然只在服务端日志里打。前端拿到 `code` 就能区分"重名冲突"还是"后端炸了"，
/// 不用解析中文 message。
const CODE_VALIDATION: &str = "validation_error";
const CODE_INVALID_JSON: &str = "invalid_json";
const CODE_UNAUTHORIZED: &str = "unauthorized";
const CODE_FORBIDDEN: &str = "forbidden";
const CODE_PASSWORD_CHANGE_REQUIRED: &str = "password_change_required";
const CODE_NOT_FOUND: &str = "not_found";
const CODE_INTERNAL: &str = "internal_error";
const CODE_TOO_MANY_REQUESTS: &str = "too_many_requests";
const CODE_SERVICE_UNAVAILABLE: &str = "service_unavailable";

const CODE_DB_ROW_NOT_FOUND: &str = "row_not_found";
const CODE_DB_UNIQUE_VIOLATION: &str = "unique_violation";
const CODE_DB_FK_VIOLATION: &str = "foreign_key_violation";
const CODE_DB_NOT_NULL_VIOLATION: &str = "not_null_violation";
const CODE_DB_CHECK_VIOLATION: &str = "check_violation";
const CODE_DB_PERMISSION_DENIED: &str = "permission_denied";
const CODE_DB_RAISE: &str = "function_raised";
const CODE_DB_SCHEMA_MISSING: &str = "schema_missing";
const CODE_DB_POOL_TIMEOUT: &str = "pool_timeout";
const CODE_DB_POOL_CLOSED: &str = "pool_closed";
const CODE_DB_STALE_PLAN: &str = "stale_cached_plan";
const CODE_DB_GENERIC: &str = "database_error";

/// 数据库函数 `RAISE EXCEPTION` 的消息回传给客户端时的最大字符数。
///
/// 业务函数的 raise 消息绝大多数情况下是给调用方看的（"权限不足" / "参数不合法"
/// 之类），但偶尔会拼了 SQL 片段或内部状态，太长直接回去既费带宽又有泄露风险，
/// 所以截到一个保守值。
const RAISE_MESSAGE_MAX: usize = 200;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message, code) = match self {
            AppError::Database(ref e) => classify_db_error(e),
            AppError::InvalidQuery(ref msg) => {
                (StatusCode::BAD_REQUEST, msg.clone(), CODE_VALIDATION)
            }
            AppError::InvalidJson(ref e) => {
                tracing::warn!(error.kind = "invalid_json", "请求 JSON 解析失败: {}", e);
                (
                    StatusCode::BAD_REQUEST,
                    "请求数据格式错误".to_string(),
                    CODE_INVALID_JSON,
                )
            }
            AppError::Unauthorized(ref msg) => {
                (StatusCode::UNAUTHORIZED, msg.clone(), CODE_UNAUTHORIZED)
            }
            AppError::Forbidden(ref msg) => (StatusCode::FORBIDDEN, msg.clone(), CODE_FORBIDDEN),
            AppError::PasswordChangeRequired(ref msg) => (
                StatusCode::FORBIDDEN,
                msg.clone(),
                CODE_PASSWORD_CHANGE_REQUIRED,
            ),
            AppError::NotFound(ref msg) => (StatusCode::NOT_FOUND, msg.clone(), CODE_NOT_FOUND),
            AppError::Internal(ref msg) => {
                tracing::error!(error.kind = "internal", "内部错误: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "服务器内部错误".to_string(),
                    CODE_INTERNAL,
                )
            }
            AppError::TooManyRequests(ref msg) => (
                StatusCode::TOO_MANY_REQUESTS,
                msg.clone(),
                CODE_TOO_MANY_REQUESTS,
            ),
            AppError::ServiceUnavailable(ref msg) => {
                tracing::warn!(error.kind = "service_unavailable", "服务不可用: {}", msg);
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "服务暂时不可用，请稍后重试".to_string(),
                    CODE_SERVICE_UNAVAILABLE,
                )
            }
        };

        let body = Json(json!({
            "error": error_message,
            "code": code,
        }));

        (status, body).into_response()
    }
}

/// 把 `sqlx::Error` 拆成 `(HTTP 状态, 中文 message, 稳定 code)`。
///
/// 设计要点：
/// - **状态码语义化**：唯一冲突 → 409；外键冲突 → 409；NOT NULL / CHECK → 400；
///   pool timeout → 503；其它 → 500。客户端能看 status 直接判断要不要重试。
/// - **schema 缺失（42P01 / 42703）**：单独打 `error!`，提示部署/迁移问题，
///   方便 SRE 在日志里捞这一类"业务永远不可能恢复"的错误。
/// - **不向客户端泄露表名 / 列名 / SQL**：响应只回固定文案 + 稳定 code，
///   schema 信息只在服务端日志里出现。
/// - **结构化字段优先**：`error.kind` / `sqlstate` / `table` / `constraint` 走
///   `tracing` 的 structured field，被 `OnebaseJsonFormatter` 平铺到 JSON
///   根字段，ELK 上能直接 `error.kind:db_error AND sqlstate:23505`。
fn classify_db_error(e: &sqlx::Error) -> (StatusCode, String, &'static str) {
    match e {
        sqlx::Error::RowNotFound => {
            tracing::warn!(
                error.kind = "row_not_found",
                "数据库未返回结果（可能是资源不存在或被并发删除）"
            );
            (
                StatusCode::NOT_FOUND,
                "资源不存在".to_string(),
                CODE_DB_ROW_NOT_FOUND,
            )
        }
        sqlx::Error::Database(db_err) => {
            let code_cow = db_err.code();
            let sqlstate = code_cow.as_deref().unwrap_or("");
            let table = db_err.table().unwrap_or("");
            let constraint = db_err.constraint().unwrap_or("");

            match sqlstate {
                "23505" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        constraint = %constraint,
                        "唯一约束冲突: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::CONFLICT,
                        "记录已存在或唯一约束冲突".to_string(),
                        CODE_DB_UNIQUE_VIOLATION,
                    )
                }
                "23503" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        constraint = %constraint,
                        "外键约束冲突: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::CONFLICT,
                        "外键约束冲突，关联资源不存在或仍被引用".to_string(),
                        CODE_DB_FK_VIOLATION,
                    )
                }
                "23502" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        "NOT NULL 约束: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::BAD_REQUEST,
                        "缺少必填字段".to_string(),
                        CODE_DB_NOT_NULL_VIOLATION,
                    )
                }
                "23514" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        constraint = %constraint,
                        "CHECK 约束: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::BAD_REQUEST,
                        "字段值不满足约束".to_string(),
                        CODE_DB_CHECK_VIOLATION,
                    )
                }
                // 42501 insufficient_privilege —— 既覆盖 PG 自身的 GRANT 不足，也
                // 覆盖业务函数里 `RAISE EXCEPTION ... USING ERRCODE = '42501'`。
                // 后者是数据库函数主动表达的"权限拒绝"，message 通常对调用方有用
                // （比如 "Access denied: not authorized for project 4"），透传给前端
                // 比起一句"数据库操作失败"实用得多；为安全起见做长度截断。
                "42501" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        "权限拒绝: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::FORBIDDEN,
                        truncate_for_client(db_err.message()),
                        CODE_DB_PERMISSION_DENIED,
                    )
                }
                // P0001 raise_exception —— PL/pgSQL `RAISE EXCEPTION` 默认 sqlstate。
                // 业务函数用这个表达"参数不合法 / 业务规则未满足"。对应 HTTP 400，
                // message 同样透传（截断）。客户端拿到 `code:"function_raised"` 就知道
                // 这是来自数据库函数的业务错误，而不是后端 bug。
                "P0001" => {
                    tracing::warn!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        "数据库函数业务异常: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::BAD_REQUEST,
                        truncate_for_client(db_err.message()),
                        CODE_DB_RAISE,
                    )
                }
                // 0A000 feature_not_supported —— PostgreSQL 在「预处理计划的结果类型
                // 与表当前结构不一致」时抛此码，message 为 "cached plan must not change
                // result type"。成因：租户库 DDL 改表后，连接上残留的旧 plan 被复用。
                // 我们已在 pool_manager 关掉 sqlx 的 statement cache，正常不再触发；但
                // PL/pgSQL 函数自身的计划缓存不受该开关控制，仍可能偶发。此时**换条连接
                // 重试即可自愈**，故映射为可重试的 503（而非不透明的 500）。
                //
                // 只认带 "cached plan" 的 0A000；其它 0A000（真正的功能不支持）继续走
                // 下面的通用 500 分支。
                "0A000" if db_err.message().contains("cached plan") => {
                    tracing::warn!(
                        error.kind = "db_stale_plan",
                        sqlstate = %sqlstate,
                        table = %table,
                        "预处理计划过期（表结构变更后残留旧 plan），建议重试: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "数据库结构刚发生变更，请重试".to_string(),
                        CODE_DB_STALE_PLAN,
                    )
                }
                // undefined_table / undefined_column / undefined_object —— 几乎一定是
                // 部署 / 迁移漏跑的产物，业务里不应该出现。打到 ERROR 让告警捞出来。
                "42P01" | "42703" | "42704" => {
                    tracing::error!(
                        error.kind = "db_schema_missing",
                        sqlstate = %sqlstate,
                        table = %table,
                        "数据库 schema 缺失或不一致，疑似缺少 migration: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "数据库结构异常，请联系管理员".to_string(),
                        CODE_DB_SCHEMA_MISSING,
                    )
                }
                _ => {
                    tracing::error!(
                        error.kind = "db_error",
                        sqlstate = %sqlstate,
                        table = %table,
                        constraint = %constraint,
                        "数据库错误: {}",
                        db_err.message()
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "数据库操作失败".to_string(),
                        CODE_DB_GENERIC,
                    )
                }
            }
        }
        sqlx::Error::PoolTimedOut => {
            // 兜底埋点：这里拿不到具体是哪个池，但能保证「池超时」这个信号一定出现在
            // /api/monitor/pool-health 上，而不是只躺在日志里。带 database_id 的精确
            // 归因由 workflow_engine 的 acquire_traced 负责。
            crate::pool_metrics::record_timeout(None, "http");
            tracing::error!(error.kind = "pool_timeout", "数据库连接池超时");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "数据库繁忙，请稍后重试".to_string(),
                CODE_DB_POOL_TIMEOUT,
            )
        }
        sqlx::Error::PoolClosed => {
            tracing::error!(error.kind = "pool_closed", "数据库连接池已关闭");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "数据库不可用".to_string(),
                CODE_DB_POOL_CLOSED,
            )
        }
        // 其余（Io / Tls / Protocol / Configuration / Decode / ...）都按 500 处理；
        // 详细信息走日志，不把 driver 内部细节回给客户端。
        other => {
            tracing::error!(error.kind = "db_other", "数据库错误: {}", other);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "数据库操作失败".to_string(),
                CODE_DB_GENERIC,
            )
        }
    }
}

/// 把数据库函数 `RAISE EXCEPTION` 的消息按字符（不是字节）截到上限，溢出时尾部加省略号。
///
/// 用字符长度而不是字节长度的原因：PG 消息常含中文，按字节切容易切到 UTF-8 半个字符
/// 触发后续 `from_utf8` 失败 / 控制台乱码。`chars().take(N).collect()` 就不会出问题。
fn truncate_for_client(msg: &str) -> String {
    let trimmed = msg.trim();
    let count = trimmed.chars().count();
    if count <= RAISE_MESSAGE_MAX {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(RAISE_MESSAGE_MAX).collect();
        s.push('…');
        s
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use serde_json::Value;

    async fn body_json(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        (status, v)
    }

    #[tokio::test]
    async fn row_not_found_maps_to_404() {
        let err = AppError::Database(sqlx::Error::RowNotFound);
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], CODE_DB_ROW_NOT_FOUND);
        // 文案不暴露 schema 细节
        assert_eq!(body["error"], "资源不存在");
    }

    #[tokio::test]
    async fn pool_timeout_maps_to_503() {
        let err = AppError::Database(sqlx::Error::PoolTimedOut);
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], CODE_DB_POOL_TIMEOUT);
    }

    #[tokio::test]
    async fn invalid_query_keeps_message_and_emits_code() {
        let err = AppError::InvalidQuery("缺少 name".into());
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "缺少 name");
        assert_eq!(body["code"], CODE_VALIDATION);
    }

    #[tokio::test]
    async fn forbidden_keeps_message() {
        let err = AppError::Forbidden("仅超管可访问".into());
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "仅超管可访问");
        assert_eq!(body["code"], CODE_FORBIDDEN);
    }

    #[tokio::test]
    async fn not_found_keeps_message() {
        let err = AppError::NotFound("用户 42 不存在".into());
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "用户 42 不存在");
        assert_eq!(body["code"], CODE_NOT_FOUND);
    }

    #[test]
    fn truncate_for_client_keeps_short_unchanged() {
        assert_eq!(truncate_for_client("hello"), "hello");
        assert_eq!(truncate_for_client("  hello  "), "hello"); // trim
    }

    #[test]
    fn truncate_for_client_caps_long_messages() {
        let long = "字".repeat(RAISE_MESSAGE_MAX + 50);
        let out = truncate_for_client(&long);
        // 200 个字符 + 一个 '…'
        assert_eq!(out.chars().count(), RAISE_MESSAGE_MAX + 1);
        assert!(out.ends_with('…'));
    }

    #[tokio::test]
    async fn internal_returns_generic_message_not_leaking_detail() {
        let err = AppError::Internal("password=hunter2 failed to bind".into());
        let (status, body) = body_json(err.into_response()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        // 客户端只看到固定文案，敏感细节只在日志里
        assert_eq!(body["error"], "服务器内部错误");
        assert_eq!(body["code"], CODE_INTERNAL);
    }
}
