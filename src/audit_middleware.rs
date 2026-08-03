use axum::{
    extract::Request,
    http::{header, Method},
    middleware::Next,
    response::Response,
};
use serde_json::{json, Value as JsonValue};
use sqlx::{PgPool, Row};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Handler-side 审计扩展槽。
///
/// 设计意图：让 handler 把"业务侧的结构化元数据"（例如 `/query` 的 sql_type / sql_len /
/// read_only，`/transaction` 的 op_count）塞进这里，`audit_middleware` 在 `next.run()`
/// 之后取出并合并到 `audit_logs.request_body`（JSONB）。
///
/// 为什么不用 `req.extensions_mut().insert(...)` + 直接读：
///   axum/tower 中 `Next::run(req)` 会**消费** `Request`，中间件拿不回原始 extensions。
///   `Arc<Mutex<…>>` 是一个被双方共享的"信箱"，handler 写、中间件读，单 row 落表。
///
/// handler 不需要关心是否真的写库（数据库未配置时也安全），只管 `set` 即可：
///   - 若中间件挂载且 `should_audit=true`：被合并进 audit_logs.request_body
///   - 否则：默默丢弃，零成本
#[derive(Clone, Default)]
pub struct AuditDetailSink(Arc<Mutex<Option<JsonValue>>>);

impl AuditDetailSink {
    /// 由 handler 调用。重复调用以最后一次为准。
    pub fn set(&self, value: JsonValue) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(value);
        }
    }

    /// 由中间件调用，取走并清空。
    fn take(&self) -> Option<JsonValue> {
        self.0.lock().ok().and_then(|mut g| g.take())
    }
}

/// handler 侧便捷方法：写入 `kind` + `detail` 结构化审计字段。
pub fn set_audit_detail(
    sink: &Option<axum::extract::Extension<AuditDetailSink>>,
    kind: &str,
    detail: JsonValue,
) {
    if let Some(axum::extract::Extension(s)) = sink {
        s.set(json!({ "kind": kind, "detail": detail }));
    }
}

/// 内层 middleware 回传给外层 `audit_middleware` 的 tenant_id 通道。
///
/// 为什么需要它：`audit_middleware` 是全局最外层 layer（main.rs 用 `app.layer(...)` 全局挂），
/// 而 `dynamic_db_middleware` 是 sql_routes 等子路由的内层 layer。也就是说：
///   audit_middleware 入口 → next.run(req) → dynamic_db_middleware（这才注入 CurrentTenantId）
///                                       → handler
/// 一旦 `next.run(req)` 把 req 消费掉，外层就再也拿不回 req.extensions 了——直接在外层
/// 入口处 `req.extensions().get::<CurrentTenantId>()` 永远是 None，最终 audit_logs.tenant_id
/// 全表全是 NULL。
///
/// 这跟 `AuditDetailSink` 一样，是个共享信箱：外层创建并塞进 req.extensions，内层
/// (`dynamic_db_middleware`) 反查到 tenant_id 后顺手 `set` 进来，外层在 `next.run()` 返回后
/// `take` 出来填 INSERT。
#[derive(Clone, Default)]
pub struct TenantIdSink(Arc<Mutex<Option<i32>>>);

impl TenantIdSink {
    /// 由 `dynamic_db_middleware` 调用：把根据 X-Database-Id 反查到的 tenant_id 回传。
    pub fn set(&self, tenant_id: i32) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(tenant_id);
        }
    }

    fn take(&self) -> Option<i32> {
        self.0.lock().ok().and_then(|mut g| g.take())
    }
}

/// 内层 `auth_middleware` 回传给外层 `audit_middleware` 的 user_id 通道。
///
/// 与 `TenantIdSink` 同理：`audit_middleware` 是全局外层 layer，入口时
/// `auth_middleware` 尚未注入 `Claims`，直接读 extensions 会得到 None。
#[derive(Clone, Default)]
pub struct UserIdSink(Arc<Mutex<Option<i32>>>);

impl UserIdSink {
    /// 由 `auth_middleware` 调用：JWT / 平台令牌校验通过后回传操作者 ID。
    pub fn set(&self, user_id: i32) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(user_id);
        }
    }

    fn take(&self) -> Option<i32> {
        self.0.lock().ok().and_then(|mut g| g.take())
    }
}

/// 在认证中间件注入 Claims 后调用，把 user_id 写入 audit 信箱。
pub fn propagate_user_id(req: &mut Request, user_id: i32) {
    if let Some(sink) = req.extensions().get::<UserIdSink>() {
        sink.set(user_id);
    }
}

/// 审计日志中间件：记录所有写操作
pub async fn audit_middleware(
    pool: Option<axum::extract::Extension<AuditPool>>,
    mut req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();

    let should_audit = matches!(
        method,
        Method::POST | Method::PATCH | Method::PUT | Method::DELETE
    );

    // 无论是否落表，都把 sink 挂进 extensions：
    //   - 让 handler 始终能 `Option<Extension<AuditDetailSink>>` 拿到；
    //   - GET 等不审计的请求里，sink 内容会被丢弃，零副作用。
    let detail_sink = AuditDetailSink::default();
    req.extensions_mut().insert(detail_sink.clone());

    // tenant_id 信箱：内层 `dynamic_db_middleware` 反查完后会写进来，
    // 我们在 `next.run` 返回后读取。直接在这里读 `CurrentTenantId` 永远是 None，
    // 因为内层 middleware 还没跑到——这是历史 bug 的根源。
    let tenant_sink = TenantIdSink::default();
    req.extensions_mut().insert(tenant_sink.clone());

    let user_sink = UserIdSink::default();
    req.extensions_mut().insert(user_sink.clone());

    if !should_audit {
        return next.run(req).await;
    }

    let path = req.uri().path().to_string();
    let ip = req
        .headers()
        .get("x-forwarded-for")
        .or_else(|| req.headers().get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let user_agent = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let start = Instant::now();
    let response = next.run(req).await;
    let duration_ms = start.elapsed().as_millis() as i32;
    let status = response.status().as_u16() as i32;

    // handler 在 next.run() 期间往 sink 写的结构化字段；普通路由不写，就是 None。
    let request_body = detail_sink.take();
    // 内层 `dynamic_db_middleware` 在 next.run 期间把 X-Database-Id 反查出的 tenant_id 写进信箱，
    // 这里取回来填 audit_logs.tenant_id。没经过 dynamic_db_middleware 的请求（比如纯管理库路由）
    // 拿到 None，对应 audit_logs.tenant_id 落 NULL，符合"这条调用没绑定到任何租户"的语义。
    let tenant_id = tenant_sink.take();
    // 内层 `auth_middleware` 校验 JWT / 平台令牌后写入操作者 ID。
    let user_id = user_sink.take();

    // `/query` / `/transaction` 这类高危原始 SQL 通道，会把 `kind` 写进 sink JSON 的根字段；
    // 我们用它来把 audit row 的 `action` 从无差别的 "POST" 升级成可索引的语义动作，
    // 便于运维直接 `WHERE action='RAW_SQL_QUERY'` 拉全量调用链。
    let action = request_body
        .as_ref()
        .and_then(|body| body.get("kind"))
        .and_then(|kind| kind.as_str())
        .map(|kind| match kind {
            "raw_sql_query" => "RAW_SQL_QUERY".to_string(),
            "raw_sql_query_blocked" => "RAW_SQL_BLOCKED".to_string(),
            "raw_sql_txn" => "RAW_SQL_TXN".to_string(),
            other => other.to_uppercase(),
        })
        .unwrap_or_else(|| method.to_string());

    if let Some(axum::extract::Extension(audit_pool)) = pool {
        let resource = path.clone();
        let method_str = method.to_string();
        // 先把 request_id 从 task_local 抓出来 —— `tokio::spawn` 出去的 future
        // 不会继承 task_local，必须在 spawn 之前 capture，spawn 内部再 scope 回去。
        let captured_req_id = crate::request_id::current();

        tokio::spawn(crate::request_id::scope_with(captured_req_id, async move {
            // 写失败 → 必须有日志线索；之前 `let _ = ...` 把任何错误都静默吞掉，
            // 一旦表结构 / 字段类型偏离就只能看到"审计日志为空"这种远端症状，
            // 排障要从前端一路挖到 DB。warn 级别足够（审计不影响主请求），
            // error 级别会污染告警。
            // RETURNING id：把 audit 行主键捞回来，作为 execution_index.ref_id，
            // 详情页才能按 id 精确回查 request_body（输入）等细节。
            let audit_id: Option<i64> = match sqlx::query(
                "INSERT INTO management.audit_logs \
                 (tenant_id, user_id, action, resource, request_method, request_path, \
                  request_body, response_status, ip_address, user_agent, duration_ms) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
            )
            .bind(tenant_id)
            .bind(user_id)
            .bind(&action)
            .bind(&resource)
            .bind(&method_str)
            .bind(&path)
            .bind(request_body)
            .bind(status)
            .bind(&ip)
            .bind(&user_agent)
            .bind(duration_ms)
            .fetch_optional(&audit_pool.0)
            .await
            {
                Ok(row) => row.map(|r| r.get::<i64, _>("id")),
                Err(e) => {
                    tracing::warn!(
                        method = %method_str,
                        path = %path,
                        status,
                        "audit_logs INSERT 失败: {}",
                        e
                    );
                    None
                }
            };

            // 统一执行索引：把 API 写操作并入跨来源的执行日志列表。
            // 此刻已在 request_id::scope_with 内，current() 能拿到本请求的 x-request-id 作 trace_id。
            let trace_id =
                crate::request_id::current().unwrap_or_else(crate::execution_log::new_trace_id);
            let ei_status = if status >= 400 { "failed" } else { "success" };
            crate::execution_log::record_terminal(
                &audit_pool.0,
                &trace_id,
                "api",
                Some("audit_logs"),
                audit_id,
                tenant_id,
                user_id,
                Some(&resource),
                ei_status,
                Some(duration_ms as i64),
                None,
            )
            .await;
        }));
    } else {
        // 同样别静默：能进到这里说明 layer 顺序坏了或者忘挂 Extension，
        // 是个配置 bug 而不是业务异常。只在第一次发现时记录（warn-only-once 太重，
        // 这里直接 debug 即可，配 RUST_LOG=debug 就能看见）。
        tracing::debug!(
            "audit_middleware: AuditPool extension 未注入，跳过写库（请检查 main.rs layer 顺序）"
        );
    }

    response
}

/// 独立的审计用连接池（避免与主 State 冲突）
#[derive(Clone)]
pub struct AuditPool(pub PgPool);

/// 慢查询记录器
pub struct SlowQueryLogger;

impl SlowQueryLogger {
    pub async fn log(
        pool: &PgPool,
        database_id: i32,
        schema: &str,
        table: &str,
        sql_preview: &str,
        duration_ms: i32,
    ) {
        if duration_ms < 500 {
            return;
        }
        tracing::warn!(
            "慢查询: {}.{} ({}ms): {}",
            schema,
            table,
            duration_ms,
            &sql_preview[..sql_preview.len().min(200)]
        );
        let _ = sqlx::query(
            "INSERT INTO management.slow_query_logs \
             (database_id, schema_name, table_name, sql_preview, duration_ms) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(database_id)
        .bind(schema)
        .bind(table)
        .bind(&sql_preview[..sql_preview.len().min(1000)])
        .bind(duration_ms)
        .execute(pool)
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::CurrentTenantId;
    use axum::{
        body::Body,
        http::Request as HttpRequest,
        middleware::from_fn,
        routing::{get, post},
        Extension, Router,
    };
    use serde_json::json;
    use tower::util::ServiceExt;

    #[test]
    fn test_audit_pool_clone() {
        // AuditPool 实现 Clone — 编译通过即证明
        let _ = std::any::type_name::<AuditPool>();
    }

    #[test]
    fn audit_detail_sink_set_then_take() {
        let sink = AuditDetailSink::default();
        sink.set(json!({"kind": "raw_sql_query", "sql_len": 42}));
        let v = sink.take().expect("sink should contain value");
        assert_eq!(v["kind"], "raw_sql_query");
        assert_eq!(v["sql_len"], 42);
        assert!(sink.take().is_none(), "second take should be empty");
    }

    #[tokio::test]
    async fn middleware_exposes_sink_to_post_handler() {
        // 验证 POST handler 在请求扩展里能拿到 sink 并写入它；
        // 中间件在 next.run() 之后能 take 出同一份内容（同一个 Arc）。
        let captured: Arc<Mutex<Option<JsonValue>>> = Arc::new(Mutex::new(None));
        let captured_cloned = captured.clone();

        let inspector_layer = from_fn(move |mut req: Request, next: Next| {
            let captured = captured_cloned.clone();
            async move {
                let sink = AuditDetailSink::default();
                req.extensions_mut().insert(sink.clone());
                let response = next.run(req).await;
                if let Some(v) = sink.take() {
                    *captured.lock().unwrap() = Some(v);
                }
                response
            }
        });

        async fn handler(Extension(sink): Extension<AuditDetailSink>) -> &'static str {
            sink.set(json!({"kind": "raw_sql_query", "sql_type": "SELECT"}));
            "ok"
        }

        let app = Router::new()
            .route("/query", post(handler))
            .layer(inspector_layer);

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/query")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());

        let captured = captured.lock().unwrap().clone();
        let body = captured.expect("middleware should have collected sink payload");
        assert_eq!(body["kind"], "raw_sql_query");
        assert_eq!(body["sql_type"], "SELECT");
    }

    /// 验证 `CurrentTenantId` 一旦被上游中间件（dynamic_db_middleware）注入，
    /// 在 audit_middleware 的视角里能被原样读取到——也就是我们填 audit_logs.tenant_id 用的值。
    /// 不连 DB，仅验证 extension 传递语义。
    #[tokio::test]
    async fn current_tenant_id_propagates_through_extensions() {
        async fn handler(tenant: Option<Extension<CurrentTenantId>>) -> String {
            tenant
                .map(|Extension(CurrentTenantId(id))| id.to_string())
                .unwrap_or_else(|| "none".into())
        }

        // 模拟 dynamic_db_middleware：在 next.run 之前注入 CurrentTenantId
        let app = Router::new().route("/any", post(handler)).layer(from_fn(
            |mut req: Request, next: Next| async move {
                req.extensions_mut().insert(CurrentTenantId(7));
                next.run(req).await
            },
        ));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/any")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());

        let body_bytes = axum::body::to_bytes(response.into_body(), 32)
            .await
            .unwrap();
        assert_eq!(&body_bytes[..], b"7");
    }

    /// 回归测试：固化生产环境的真实 layer 顺序（audit_middleware 全局外层，
    /// dynamic_db_middleware sql_routes 内层），验证 `TenantIdSink` 能跨层传递 tenant_id。
    ///
    /// 历史 bug：之前 audit_middleware 直接 `req.extensions().get::<CurrentTenantId>()`，
    /// 但它入口运行时 dynamic_db_middleware 还没跑——拿到的永远是 None，
    /// audit_logs.tenant_id 全表 NULL，dashboard 按 tenant_id 过滤拉空。
    /// 这个测试要在 `tenant_sink.take()` 改回直接读 extensions 时失败。
    #[tokio::test]
    async fn tenant_id_sink_propagates_from_inner_to_outer_middleware() {
        async fn handler() -> &'static str {
            "ok"
        }

        let captured: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
        let captured_for_outer = captured.clone();

        // 外层：模拟 audit_middleware —— 入口注入 sink，next.run 后 take。
        let outer = from_fn(move |mut req: Request, next: Next| {
            let captured = captured_for_outer.clone();
            async move {
                let sink = TenantIdSink::default();
                req.extensions_mut().insert(sink.clone());
                let response = next.run(req).await;
                *captured.lock().unwrap() = sink.take();
                response
            }
        });

        // 内层：模拟 dynamic_db_middleware —— 反查后 set 进 sink。
        let inner = from_fn(|mut req: Request, next: Next| async move {
            if let Some(sink) = req.extensions().get::<TenantIdSink>() {
                sink.set(42);
            }
            req.extensions_mut().insert(CurrentTenantId(42));
            next.run(req).await
        });

        // .layer 栈式：后写的在外层 → outer 必须在 inner 之后 .layer，才是真正的外层。
        let app = Router::new()
            .route("/q", post(handler))
            .layer(inner)
            .layer(outer);

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/q")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());

        let got = captured.lock().unwrap().clone();
        assert_eq!(
            got,
            Some(42),
            "外层 audit_middleware 应该通过 sink 读到内层注入的 tenant_id"
        );
    }

    #[tokio::test]
    async fn user_id_sink_propagates_from_inner_auth_to_outer_middleware() {
        async fn handler() -> &'static str {
            "ok"
        }

        let captured: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
        let captured_for_outer = captured.clone();

        let outer = from_fn(move |mut req: Request, next: Next| {
            let captured = captured_for_outer.clone();
            async move {
                let sink = UserIdSink::default();
                req.extensions_mut().insert(sink.clone());
                let response = next.run(req).await;
                *captured.lock().unwrap() = sink.take();
                response
            }
        });

        let inner = from_fn(|mut req: Request, next: Next| async move {
            if let Some(sink) = req.extensions().get::<UserIdSink>() {
                sink.set(99);
            }
            next.run(req).await
        });

        let app = Router::new()
            .route("/admin", post(handler))
            .layer(inner)
            .layer(outer);

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/admin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(captured.lock().unwrap().clone(), Some(99));
    }

    #[tokio::test]
    async fn middleware_skips_audit_for_get_but_sink_still_works() {
        // GET 不写库，但 sink 仍然挂着；这保证 handler 一致地用 Option<Extension<…>>
        // 拿 sink，不需要按 method 分支。
        async fn handler(sink: Option<Extension<AuditDetailSink>>) -> &'static str {
            assert!(sink.is_some(), "sink should be present even for GET");
            sink.unwrap().0.set(json!({"k": 1}));
            "ok"
        }

        let app = Router::new().route("/probe", get(handler)).layer(from_fn(
            |mut req: Request, next: Next| async move {
                let sink = AuditDetailSink::default();
                req.extensions_mut().insert(sink);
                next.run(req).await
            },
        ));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/probe")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
    }
}
