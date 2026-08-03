# 通用对外事件订阅端点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把硬编码的 `/growth-animation/events` 抽象为「配置表 + 单一通用 handler `GET /events/:slug`」，新增对外订阅场景仅需页面加一行配置，零代码。

**Architecture:** 新增 `management.sse_public_endpoints` 配置表；通用 handler 按 slug 读配置，从可信请求头取身份、按 `topic_template`（`{identity}` + `{query.X}`）渲染订阅 topic 后流式推送；CRUD 在「实时推送规则」页新增「对外端点」tab。`ConnMeta` 通用化、监控按端点聚合。成长动画退化为一条示例配置。

**Tech Stack:** Rust / Axum / SQLx（后端），Next.js / React / TypeScript（前端），PostgreSQL。

**Spec:** `docs/superpowers/specs/2026-06-01-generic-sse-subscription-endpoint-design.md`

**验证基线（每个 Rust 任务结尾）：** 用既有 target 增量编译，跑相关单测：
```bash
cargo test --bin onebase sse:: -- --nocapture
cargo check
```
（沙箱内 `mlua-sys` 可能编译失败；如遇 `Operation not permitted` / `No space left`，用 `required_permissions: ["all"]` 在沙箱外跑，复用默认 `target`，不要另设 `CARGO_TARGET_DIR`。）

---

## Task 1: 配置表迁移

**Files:**
- Create: `migrations/025_sse_public_endpoints.sql`
- Modify: `src/migrate.rs`（`MIGRATIONS` 数组，line 93-94 之后）

- [ ] **Step 1: 写迁移 SQL**

Create `migrations/025_sse_public_endpoints.sql`:

```sql
-- 通用对外事件订阅端点配置表
--
-- 通用 handler GET /events/{slug}（src/sse.rs）按本表逐条驱动：
-- 从 identity_header 指定的可信请求头取身份，按 topic_template 渲染订阅 topic
-- （{identity} 必填、保证只能订到自己的；{query.X} 取 URL query，缺省退化为末尾通配 *），
-- 命中的消息以 event_name 为事件名、payload 原样透传给客户端。
--
-- 配置维护：后台「实时推送规则 → 对外端点」页可视化增删改
-- （API：/api/admin/sse-public-endpoints，超管 + 端点所属租户 owner/admin）。
CREATE TABLE IF NOT EXISTS management.sse_public_endpoints (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    -- URL 路径：GET /events/{slug}，全局唯一，仅 [a-z0-9-]
    slug            VARCHAR(64)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    -- 可信身份头（网关注入），如 X-Way-UID
    identity_header VARCHAR(64)  NOT NULL,
    -- 订阅 topic 模板，必含 {identity}，可含 {query.X}；{identity} 必须在所有 {query.X} 之前
    topic_template  TEXT         NOT NULL,
    -- 下发的 SSE event 名
    event_name      VARCHAR(100) NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sse_public_endpoints_active
    ON management.sse_public_endpoints(is_active) WHERE is_active = true;

CREATE TRIGGER update_sse_public_endpoints_updated_at BEFORE UPDATE ON management.sse_public_endpoints
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

-- 成长动画启用示例（运维执行一次，或在页面「对外端点」新建；<TENANT_ID> 换成实际租户 id）：
--
--   INSERT INTO management.sse_public_endpoints (tenant_id, slug, name, identity_header, topic_template, event_name)
--   VALUES (<TENANT_ID>, 'growth-animation', '成长动画', 'X-Way-UID',
--           'way:{identity}:growth:{query.projectId}', 'growth_animation_available')
--   ON CONFLICT (slug) DO NOTHING;
```

- [ ] **Step 2: 注册迁移**

Modify `src/migrate.rs`，在 line 94（`024 sse notify bridges`）后加一行：

```rust
    ("024 sse notify bridges",   include_str!("../migrations/024_sse_notify_bridges.sql")),
    ("025 sse public endpoints", include_str!("../migrations/025_sse_public_endpoints.sql")),
```

- [ ] **Step 3: 编译验证**

Run: `cargo check`
Expected: PASS（迁移在编译期 `include_str!` 内联，无语法错误即过）。

- [ ] **Step 4: Commit**

```bash
git add migrations/025_sse_public_endpoints.sql src/migrate.rs
git commit -m "feat(sse): add sse_public_endpoints config table + migration"
```

---

## Task 2: topic 模板渲染 + 校验（纯函数 + 单测，TDD）

**Files:**
- Modify: `src/sse.rs`（在 `topic_matches`（line ~220）之后新增两个 pub fn 与单测）

- [ ] **Step 1: 写失败的单测**

在 `src/sse.rs` 文件末尾的 `#[cfg(test)] mod tests` 内加入（若需要 `HashMap`，在测试里用 `std::collections::HashMap`）：

```rust
    #[test]
    fn render_topic_identity_and_query() {
        let mut q = std::collections::HashMap::new();
        q.insert("projectId".to_string(), "1".to_string());
        assert_eq!(
            render_subscription_topic("way:{identity}:growth:{query.projectId}", "u1", &q),
            "way:u1:growth:1"
        );
    }

    #[test]
    fn render_topic_missing_query_truncates_to_wildcard() {
        let q = std::collections::HashMap::new();
        assert_eq!(
            render_subscription_topic("way:{identity}:growth:{query.projectId}", "u1", &q),
            "way:u1:growth:*"
        );
    }

    #[test]
    fn render_topic_identity_only() {
        let q = std::collections::HashMap::new();
        assert_eq!(
            render_subscription_topic("notify:{identity}", "u1", &q),
            "notify:u1"
        );
    }

    #[test]
    fn validate_template_requires_identity() {
        assert!(validate_topic_template("order:{query.orderId}").is_err());
    }

    #[test]
    fn validate_template_rejects_query_before_identity() {
        assert!(validate_topic_template("x:{query.a}:{identity}").is_err());
    }

    #[test]
    fn validate_template_rejects_unknown_placeholder() {
        assert!(validate_topic_template("x:{identity}:{foo}").is_err());
    }

    #[test]
    fn validate_template_accepts_identity_then_query() {
        assert!(validate_topic_template("way:{identity}:growth:{query.projectId}").is_ok());
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin onebase sse::tests::render_topic_identity_and_query`
Expected: FAIL（`cannot find function render_subscription_topic`）。

- [ ] **Step 3: 实现两个纯函数**

在 `src/sse.rs` 的 `topic_matches` 函数之后加入。先加 import（文件顶部已 `use std::collections::HashMap;`？若无则加）：

```rust
/// 解析 topic 模板里按顺序出现的占位符名（不含花括号），如 ["identity", "query.projectId"]。
/// 文本里没有 `{` 就返回空。遇到未闭合 `{` 视为普通文本忽略。
fn template_placeholders(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                names.push(after[..end].to_string());
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    names
}

/// 校验对外端点的 topic 模板：
/// - 必含 `{identity}`；
/// - 占位符只允许 `{identity}` 和 `{query.<param>}`；
/// - `{identity}` 必须出现在所有 `{query.X}` 之前（否则缺省 query 截断会丢掉 identity 而越权）。
pub fn validate_topic_template(template: &str) -> Result<(), String> {
    let mut seen_identity = false;
    for name in template_placeholders(template) {
        if name == "identity" {
            seen_identity = true;
        } else if let Some(param) = name.strip_prefix("query.") {
            if param.is_empty() {
                return Err("占位符 {query.} 缺少参数名".to_string());
            }
            if !seen_identity {
                return Err("{identity} 必须出现在所有 {query.X} 之前".to_string());
            }
        } else {
            return Err(format!("不支持的占位符 {{{}}}", name));
        }
    }
    if !seen_identity {
        return Err("topic 模板必须包含 {identity}".to_string());
    }
    Ok(())
}

/// 渲染订阅 topic：
/// - `{identity}` → 身份头值；
/// - `{query.X}` → query 参数 X 的值；缺省时在该位置截断、追加 `*` 并停止（末尾通配）。
/// 调用前模板应已通过 `validate_topic_template`（保证 `{identity}` 在 query 之前）。
pub fn render_subscription_topic(
    template: &str,
    identity: &str,
    query: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(template.len() + identity.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = match after.find('}') {
            Some(e) => e,
            None => {
                // 未闭合花括号：当作普通文本，原样补回剩余部分。
                out.push('{');
                rest = after;
                continue;
            }
        };
        let name = &after[..end];
        rest = &after[end + 1..];
        if name == "identity" {
            out.push_str(identity);
        } else if let Some(param) = name.strip_prefix("query.") {
            match query.get(param) {
                Some(v) => out.push_str(v),
                None => {
                    out.push('*');
                    return out; // 截断：末尾通配
                }
            }
        } else {
            // validate 已拦未知占位符；防御性原样保留。
            out.push('{');
            out.push_str(name);
            out.push('}');
        }
    }
    out.push_str(rest);
    out
}
```

确认 `src/sse.rs` 顶部导入区有 `use std::collections::HashMap;`，没有则加上。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --bin onebase sse::tests`
Expected: PASS（含上面 7 个新测试 + 原有 topic_matches 测试）。

- [ ] **Step 5: Commit**

```bash
git add src/sse.rs
git commit -m "feat(sse): add topic template render + validate for public endpoints"
```

---

## Task 3: `ConnMeta` 通用化 + 同步现有用法

**Files:**
- Modify: `src/sse.rs`（`ConnMeta` 定义 line 64-75；`sse_handler` 插入处 line 266-275）
- Modify: `src/sse_notify_bridge_handlers.rs`（`stats` 聚合，line ~30-43）

- [ ] **Step 1: 改 `ConnMeta` 定义**

把 `src/sse.rs` line 64-75 替换为：

```rust
/// 单条 SSE 连接的元信息（仅进程内、用于监控）。
///
/// `identity` 仅供服务端日志/排障，不对外暴露（监控页只按端点聚合计数）。
#[derive(Debug, Clone)]
#[allow(dead_code)] // identity / connected_at 为监控/日志保留字段
pub struct ConnMeta {
    /// 连接类型："sse"（通用 /sse）或 "public"（/events/:slug 对外端点）。
    pub kind: &'static str,
    /// 对外端点连接所属的端点 slug；通用 /sse 连接为 None。
    pub endpoint_slug: Option<String>,
    /// 对外端点连接的身份（来自可信头）；通用 /sse 连接为 None。
    pub identity: Option<String>,
    pub connected_at: DateTime<Utc>,
}
```

- [ ] **Step 2: 改 `sse_handler` 的插入处**

把 `src/sse.rs` line 267-275 的 `hub.connections.insert(...)` 块替换为：

```rust
    hub.connections.insert(
        conn_id.clone(),
        ConnMeta {
            kind: "sse",
            endpoint_slug: None,
            identity: None,
            connected_at: Utc::now(),
        },
    );
```

- [ ] **Step 3: 改 stats 聚合**

把 `src/sse_notify_bridge_handlers.rs` 的 `stats` 里连接聚合（`let total = ...` 到 `by_project` 那段，约 line 30-52）替换为按端点 slug 聚合：

```rust
    let conns = hub.connection_metas();
    let total = conns.len();
    let public = conns.iter().filter(|c| c.kind == "public").count();
    let generic = conns.iter().filter(|c| c.kind == "sse").count();

    // 按端点 slug 聚合对外端点连接。
    let mut by_endpoint: BTreeMap<String, usize> = BTreeMap::new();
    for c in conns.iter().filter(|c| c.kind == "public") {
        let slug = c.endpoint_slug.clone().unwrap_or_else(|| "(unknown)".to_string());
        *by_endpoint.entry(slug).or_insert(0) += 1;
    }
    let by_endpoint: Vec<serde_json::Value> = by_endpoint
        .into_iter()
        .map(|(slug, count)| json!({ "slug": slug, "count": count }))
        .collect();

    Ok(Json(json!({
        "listeners": listeners,
        "connections": {
            "total": total,
            "public": public,
            "generic": generic,
            "by_endpoint": by_endpoint,
        },
        "pushes_total": hub.pushes_total(),
    })))
```

- [ ] **Step 4: 编译验证**

Run: `cargo check`
Expected: PASS（此时旧的 growth handler 仍引用 `way_uid`/`project_id`，会编译报错 → 这是预期，下一任务删除它；若想本任务独立编译过，可与 Task 4 合并提交。为安全起见本任务与 Task 4 连续执行后再编译/提交）。

> 说明：`ConnMeta` 改字段后，`growth_events_handler` 仍在引用旧字段。Task 4 会删掉它。**Task 3 与 Task 4 一起编译、一起提交**，中间不单独 `cargo check`。

---

## Task 4: 删除硬编码的成长动画专用端点

**Files:**
- Modify: `src/sse.rs`（删除 `GrowthQuery`、`project_growth_data`、`growth_events_handler` 及其相关单测）
- Modify: `src/main.rs`（删除 `/growth-animation/events` 路由，line 600-604）

- [ ] **Step 1: 删 `src/sse.rs` 里的成长动画专用代码**

删除以下内容（全部位于 `// ───── 成长动画专用端点` 注释区起，至 `growth_events_handler` 结尾的 `keep_alive(...25s...)` 块结束）：
- `pub struct GrowthQuery { ... }`
- `fn project_growth_data(...) -> serde_json::Value { ... }`
- `pub async fn growth_events_handler(...) -> ... { ... }`
- 顶部该端点的整段说明注释（`// 不挂 auth_middleware ... 剔除 wayUid。`）

同时删除测试模块里针对 `project_growth_data` 和 `way:` 通配的单测（`fn ...project_growth...` / 引用 `project_growth_data` 的测试）。保留 `topic_matches` 与 Task 2 新增的测试。

- [ ] **Step 2: 删 `src/main.rs` 的路由**

删除 `src/main.rs` line 600-604：

```rust
        // 成长动画专用端点：浏览器 EventSource，身份取网关注入的 X-Way-UID（不挂 auth_middleware）。
        .route(
            "/growth-animation/events",
            get(sse::growth_events_handler),
        );
```

注意该 `.route(...)` 末尾有分号、是某个 router 链的收尾。删除后需保证上一行 `.route(...)` 链正确收尾（把分号移到上一段链尾，或保留该 router 变量的结束）。实现时先读 line 580-606 确认链结构，再精确删除，保持语法完整。

- [ ] **Step 3: 编译 + 测试**

Run: `cargo test --bin onebase sse:: && cargo check`
Expected: PASS（无对已删函数的引用残留）。

- [ ] **Step 4: Commit（含 Task 3）**

```bash
git add src/sse.rs src/main.rs src/sse_notify_bridge_handlers.rs
git commit -m "refactor(sse): generalize ConnMeta + remove bespoke growth-animation endpoint"
```

---

## Task 5: 通用 handler `GET /events/:slug`

**Files:**
- Modify: `src/sse.rs`（新增 `public_event_handler` 与其配置加载）

- [ ] **Step 1: 实现 handler**

在 `src/sse.rs`（建议放在 `topic_matches` / 渲染函数之后、`ConnGuard` 附近）加入。确保顶部已有 `use axum::extract::Path;`、`use axum::http::HeaderMap;`、`use std::collections::HashMap;`、`use sqlx::Row;`：

```rust
// ───── 通用对外订阅端点 ────────────────────────────────────
//
// GET /events/:slug —— 不挂 auth_middleware。按 slug 读 sse_public_endpoints 配置，
// 从 identity_header 指定的可信头取身份，渲染 topic 后流式推送。payload 原样透传。

struct PublicEndpointCfg {
    identity_header: String,
    topic_template: String,
    event_name: String,
}

async fn load_public_endpoint(pool: &PgPool, slug: &str) -> Option<PublicEndpointCfg> {
    sqlx::query(
        "SELECT identity_header, topic_template, event_name \
         FROM management.sse_public_endpoints WHERE slug = $1 AND is_active = true",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|r| PublicEndpointCfg {
        identity_header: r.get("identity_header"),
        topic_template: r.get("topic_template"),
        event_name: r.get("event_name"),
    })
}

/// `GET /events/:slug?<query>`（不挂 auth_middleware）
pub async fn public_event_handler(
    State(pool): State<PgPool>,
    Extension(hub): Extension<SseHub>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Sse<impl Stream<Item = std::result::Result<Event, Infallible>>>> {
    let cfg = load_public_endpoint(&pool, &slug)
        .await
        .ok_or_else(|| AppError::NotFound(format!("对外端点 {} 不存在或已停用", slug)))?;

    let identity = headers
        .get(&cfg.identity_header)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Unauthorized(format!("缺少 {}", cfg.identity_header)))?
        .to_string();

    let topic = render_subscription_topic(&cfg.topic_template, &identity, &query);
    let event_name = cfg.event_name.clone();

    let conn_id = uuid::Uuid::new_v4().to_string();
    hub.connections.insert(
        conn_id.clone(),
        ConnMeta {
            kind: "public",
            endpoint_slug: Some(slug.clone()),
            identity: Some(identity.clone()),
            connected_at: Utc::now(),
        },
    );
    tracing::info!(
        "对外端点 SSE 连接建立: {} (slug={}, identity={}, topic={})",
        conn_id,
        slug,
        identity,
        topic
    );

    let rx = hub.subscribe();
    let guard = ConnGuard {
        hub: hub.clone(),
        conn_id,
    };

    let connected = futures::stream::once(async move {
        Ok(Event::default()
            .event("connected")
            .json_data(serde_json::json!({ "ok": true }))
            .unwrap_or_default())
    });

    let subs = vec![topic];
    let body = futures::stream::unfold(
        (rx, subs, event_name, guard),
        |(mut rx, subs, event_name, guard)| async move {
            loop {
                match rx.recv().await {
                    Ok(env) => {
                        if !topic_matches(&subs, &env.topic) {
                            continue;
                        }
                        match Event::default().event(event_name.clone()).json_data(&env.data) {
                            Ok(event) => {
                                guard.hub.record_push();
                                return Some((Ok(event), (rx, subs, event_name, guard)));
                            }
                            Err(e) => {
                                tracing::warn!("对外端点 SSE 序列化失败，跳过: {}", e);
                                continue;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("对外端点 SSE 连接滞后，丢失 {} 条消息", n);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );

    let stream = connected.chain(body);
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .text("ping"),
    ))
}
```

> 注：`connected.chain(body)` 需要 `use futures::StreamExt;`（文件应已有，原 growth handler 用过；删除 growth 后若 import 被清理，需补回）。

- [ ] **Step 2: 编译验证**

Run: `cargo check`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/sse.rs
git commit -m "feat(sse): add generic GET /events/:slug subscription handler"
```

---

## Task 6: 端点 CRUD handlers

**Files:**
- Create: `src/sse_public_endpoint_handlers.rs`
- Modify: `src/main.rs`（声明 `mod sse_public_endpoint_handlers;`，与其它 `mod` 同处）

- [ ] **Step 1: 写 CRUD handlers**

Create `src/sse_public_endpoint_handlers.rs`：

```rust
//! 通用对外订阅端点（management.sse_public_endpoints）的管理 API（CRUD）
//!
//! 端点语义见 `src/sse.rs` 的 `public_event_handler`：GET /events/{slug} 按本表配置驱动。
//! 鉴权：端点按 tenant_id 归属租户，CRUD 走 permissions::require_tenant_admin
//! （与 sse_route_handlers / sse_notify_bridge_handlers 一致）。

use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::permissions;
use crate::sse::validate_topic_template;

const SELECT_COLS: &str =
    "id, tenant_id, slug, name, identity_header, topic_template, event_name, is_active";

fn row_to_json(r: &sqlx::postgres::PgRow) -> serde_json::Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "tenant_id": r.get::<i32, _>("tenant_id"),
        "slug": r.get::<String, _>("slug"),
        "name": r.get::<String, _>("name"),
        "identity_header": r.get::<String, _>("identity_header"),
        "topic_template": r.get::<String, _>("topic_template"),
        "event_name": r.get::<String, _>("event_name"),
        "is_active": r.get::<bool, _>("is_active"),
    })
}

/// 已存在端点是否归当前用户的租户管辖；返回 tenant_id。
async fn require_admin_for_existing(pool: &PgPool, claims: &Claims, id: i32) -> Result<i32> {
    let tenant_id: i32 =
        sqlx::query_scalar("SELECT tenant_id FROM management.sse_public_endpoints WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("对外端点 {} 不存在", id)))?;
    permissions::require_tenant_admin(pool, claims, tenant_id).await?;
    Ok(tenant_id)
}

/// slug 仅允许 [a-z0-9-]，长度 1..=64。
fn validate_slug(slug: &str) -> Result<()> {
    if slug.is_empty() || slug.len() > 64 {
        return Err(AppError::InvalidQuery("slug 长度需为 1..=64".to_string()));
    }
    if !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(AppError::InvalidQuery("slug 仅允许小写字母、数字、连字符".to_string()));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateEndpoint {
    pub tenant_id: i32,
    pub slug: String,
    pub name: String,
    pub identity_header: String,
    pub topic_template: String,
    pub event_name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEndpoint {
    pub name: Option<String>,
    pub identity_header: Option<String>,
    pub topic_template: Option<String>,
    pub event_name: Option<String>,
    pub is_active: Option<bool>,
}

/// GET /api/admin/sse-public-endpoints — 超管全量；租户 admin 仅本租户。
pub async fn list_endpoints(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let rows = if claims.is_superadmin {
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_public_endpoints ORDER BY id"
        ))
        .fetch_all(&pool)
        .await?
    } else {
        let tenant_ids = permissions::tenant_admin_ids(&pool, &claims).await?;
        if tenant_ids.is_empty() {
            return Ok(Json(json!({ "data": [] })));
        }
        sqlx::query(&format!(
            "SELECT {SELECT_COLS} FROM management.sse_public_endpoints \
             WHERE tenant_id = ANY($1) ORDER BY id"
        ))
        .bind(&tenant_ids)
        .fetch_all(&pool)
        .await?
    };
    let data: Vec<serde_json::Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(json!({ "data": data })))
}

/// POST /api/admin/sse-public-endpoints
pub async fn create_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateEndpoint>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, body.tenant_id).await?;

    let slug = body.slug.trim();
    let name = body.name.trim();
    let identity_header = body.identity_header.trim();
    let topic_template = body.topic_template.trim();
    let event_name = body.event_name.trim();
    validate_slug(slug)?;
    if name.is_empty() || identity_header.is_empty() || event_name.is_empty() {
        return Err(AppError::InvalidQuery("名称/身份头/event 名不能为空".to_string()));
    }
    validate_topic_template(topic_template).map_err(AppError::InvalidQuery)?;

    let row = sqlx::query(
        "INSERT INTO management.sse_public_endpoints \
            (tenant_id, slug, name, identity_header, topic_template, event_name) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(body.tenant_id)
    .bind(slug)
    .bind(name)
    .bind(identity_header)
    .bind(topic_template)
    .bind(event_name)
    .fetch_one(&pool)
    .await?;

    let id: i32 = row.get("id");
    Ok(Json(json!({ "data": { "id": id }, "message": "对外端点创建成功" })))
}

/// PATCH /api/admin/sse-public-endpoints/:id
pub async fn update_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
    Json(body): Json<UpdateEndpoint>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing(&pool, &claims, id).await?;

    if let Some(t) = body.topic_template.as_deref().map(str::trim) {
        validate_topic_template(t).map_err(AppError::InvalidQuery)?;
    }

    let result = sqlx::query(
        "UPDATE management.sse_public_endpoints SET \
            name = COALESCE($2, name), \
            identity_header = COALESCE($3, identity_header), \
            topic_template = COALESCE($4, topic_template), \
            event_name = COALESCE($5, event_name), \
            is_active = COALESCE($6, is_active) \
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(body.identity_header.as_deref().map(str::trim))
    .bind(body.topic_template.as_deref().map(str::trim))
    .bind(body.event_name.as_deref().map(str::trim))
    .bind(body.is_active)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("对外端点 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "更新成功" })))
}

/// DELETE /api/admin/sse-public-endpoints/:id
pub async fn delete_endpoint(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<i32>,
) -> Result<Json<serde_json::Value>> {
    require_admin_for_existing(&pool, &claims, id).await?;
    let result = sqlx::query("DELETE FROM management.sse_public_endpoints WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("对外端点 {} 不存在", id)));
    }
    Ok(Json(json!({ "message": "删除成功" })))
}
```

- [ ] **Step 2: 声明模块**

在 `src/main.rs` 的 `mod sse_notify_bridge_handlers;`（line 54 附近）旁加：

```rust
mod sse_public_endpoint_handlers;
```

- [ ] **Step 3: 编译验证**

Run: `cargo check`
Expected: PASS（`validate_topic_template` 已在 Task 2 设为 `pub`；handler 暂未挂路由，会有 `dead_code` 警告，下一任务消除）。

- [ ] **Step 4: Commit**

```bash
git add src/sse_public_endpoint_handlers.rs src/main.rs
git commit -m "feat(sse): add CRUD handlers for sse_public_endpoints"
```

---

## Task 7: 注册路由

**Files:**
- Modify: `src/main.rs`（CRUD 路由挂到 `sse_route_routes`；通用 handler 挂到公开路由处，原 growth 路由位置）

- [ ] **Step 1: 挂 CRUD 路由**

在 `src/main.rs` 的 `sse_route_routes` router 链里（NOTIFY 监听桥 CRUD 之后、`.layer(auth_middleware)` 之前）加：

```rust
        // 对外订阅端点管理（超管 + 端点所属租户 owner/admin）— handler 内按 tenant 隔离
        .route(
            "/api/admin/sse-public-endpoints",
            get(sse_public_endpoint_handlers::list_endpoints)
                .post(sse_public_endpoint_handlers::create_endpoint),
        )
        .route(
            "/api/admin/sse-public-endpoints/:id",
            patch(sse_public_endpoint_handlers::update_endpoint)
                .delete(sse_public_endpoint_handlers::delete_endpoint),
        )
```

- [ ] **Step 2: 挂通用对外 handler（公开、无 auth_middleware）**

在原 `/growth-animation/events` 所在的公开 router（已在 Task 4 删除那条路由）处，加上通用路由。先读该 router 链确认它是不挂 auth 的那条（与 `/sse` 同处）：

```rust
        // 通用对外订阅端点：浏览器 EventSource，身份取网关注入的可信头（不挂 auth_middleware）。
        .route("/events/:slug", get(sse::public_event_handler))
```

确保该路由与 `/sse` 一样在带 `State(pool)` + `Extension(SseHub)` 的 router 上（`public_event_handler` 同时需要 `State<PgPool>` 与 `Extension<SseHub>`，与 `sse_handler` 一致）。

- [ ] **Step 3: 编译验证**

Run: `cargo check`
Expected: PASS，无 `dead_code` 警告残留（CRUD + handler 均已挂）。

- [ ] **Step 4: Commit**

```bash
git add src/main.rs
git commit -m "feat(sse): wire /events/:slug + sse-public-endpoints CRUD routes"
```

---

## Task 8: 前端 API 客户端

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`（新增类型 + `ssePublicEndpointAPI`；更新监控 stats 类型）

- [ ] **Step 1: 加端点 CRUD 类型与 API**

在 `frontend-nextjs/lib/api.ts` 的 `sseNotifyBridgeAPI` 定义之后加入：

```typescript
// 通用对外订阅端点：CRUD（超管 + 租户 owner/admin）。
export interface SsePublicEndpoint {
  id: number
  tenant_id: number
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
  is_active: boolean
}

export interface CreateSsePublicEndpointInput {
  tenant_id: number
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
}

export interface UpdateSsePublicEndpointInput {
  name?: string
  identity_header?: string
  topic_template?: string
  event_name?: string
  is_active?: boolean
}

export const ssePublicEndpointAPI = {
  list: () => api.get<{ data: SsePublicEndpoint[] }>('/api/admin/sse-public-endpoints'),
  create: (input: CreateSsePublicEndpointInput) =>
    api.post<{ data: { id: number }; message: string }>('/api/admin/sse-public-endpoints', input),
  update: (id: number, input: UpdateSsePublicEndpointInput) =>
    api.patch<{ message: string }>(`/api/admin/sse-public-endpoints/${id}`, input),
  delete: (id: number) =>
    api.delete<{ message: string }>(`/api/admin/sse-public-endpoints/${id}`),
}
```

- [ ] **Step 2: 更新监控 stats 类型（连接聚合改为按端点）**

把 `SseNotifyBridgeStats` 的 `connections` 字段替换为：

```typescript
export interface SseNotifyBridgeStats {
  listeners: SseNotifyListenerStat[]
  connections: {
    total: number
    public: number
    generic: number
    by_endpoint: { slug: string; count: number }[]
  }
  pushes_total: number
}
```

- [ ] **Step 3: typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`
Expected: 仅剩 `table-designer` / `TableEditor` 历史报错；`SseMonitorPanel.tsx` 会因引用旧 `by_project`/`growth` 报错 → Task 10 修复。本步先确认没引入**新**的 api.ts 报错。

- [ ] **Step 4: Commit**

```bash
git add frontend-nextjs/lib/api.ts
git commit -m "feat(sse): add ssePublicEndpointAPI client + endpoint-based stats type"
```

---

## Task 9: 前端「对外端点」管理面板 + 接入两个页面

**Files:**
- Create: `frontend-nextjs/components/sse/SsePublicEndpointPanel.tsx`
- Modify: `frontend-nextjs/app/workspace/[projectId]/automation/sse-routes/page.tsx`（加 tab）
- Modify: `frontend-nextjs/app/dashboard/sse-routes/page.tsx`（加 tab）

- [ ] **Step 1: 写面板组件**

Create `frontend-nextjs/components/sse/SsePublicEndpointPanel.tsx`：

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ssePublicEndpointAPI,
  type SsePublicEndpoint,
  type CreateSsePublicEndpointInput,
  type UpdateSsePublicEndpointInput,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

/**
 * 通用对外订阅端点（/events/:slug）管理面板。
 *
 * 业务前端用 EventSource 连 {origin}/events/{slug}，身份头由网关注入。
 * - tenantId 给定：列表只展示该租户的端点（项目工作区用）。
 */
interface FormState {
  slug: string
  name: string
  identity_header: string
  topic_template: string
  event_name: string
}

const EMPTY_FORM: FormState = {
  slug: '',
  name: '',
  identity_header: 'X-Way-UID',
  topic_template: '',
  event_name: '',
}

function toForm(e: SsePublicEndpoint): FormState {
  return {
    slug: e.slug,
    name: e.name,
    identity_header: e.identity_header,
    topic_template: e.topic_template,
    event_name: e.event_name,
  }
}

interface Props {
  tenantId?: number | null
}

export default function SsePublicEndpointPanel({ tenantId }: Props) {
  const notify = useNotification()

  const [endpoints, setEndpoints] = useState<SsePublicEndpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [origin, setOrigin] = useState('')
  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const visible = useMemo(
    () => (tenantId == null ? endpoints : endpoints.filter((e) => e.tenant_id === tenantId)),
    [endpoints, tenantId],
  )

  const load = async () => {
    try {
      setLoading(true)
      const res = await ssePublicEndpointAPI.list()
      setEndpoints(res.data.data ?? [])
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setDrawerOpen(true)
  }

  const openEdit = (e: SsePublicEndpoint) => {
    setEditingId(e.id)
    setForm(toForm(e))
    setDrawerOpen(true)
  }

  const closeDrawer = () => {
    if (saving) return
    setDrawerOpen(false)
  }

  const handleSave = async () => {
    if (!form.slug.trim()) return notify.warning('请填写 slug')
    if (!form.name.trim()) return notify.warning('请填写名称')
    if (!form.identity_header.trim()) return notify.warning('请填写身份头')
    if (!form.topic_template.trim()) return notify.warning('请填写 topic 模板')
    if (!form.topic_template.includes('{identity}')) return notify.warning('topic 模板必须包含 {identity}')
    if (!form.event_name.trim()) return notify.warning('请填写 event 名')

    setSaving(true)
    try {
      if (editingId == null) {
        if (tenantId == null) {
          notify.warning('无法确定租户，无法创建')
          setSaving(false)
          return
        }
        const payload: CreateSsePublicEndpointInput = {
          tenant_id: tenantId,
          slug: form.slug.trim(),
          name: form.name.trim(),
          identity_header: form.identity_header.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await ssePublicEndpointAPI.create(payload)
        notify.success('对外端点已创建')
      } else {
        const payload: UpdateSsePublicEndpointInput = {
          name: form.name.trim(),
          identity_header: form.identity_header.trim(),
          topic_template: form.topic_template.trim(),
          event_name: form.event_name.trim(),
        }
        await ssePublicEndpointAPI.update(editingId, payload)
        notify.success('对外端点已更新')
      }
      setDrawerOpen(false)
      load()
    } catch (err) {
      notify.error(err as Error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (e: SsePublicEndpoint) => {
    try {
      await ssePublicEndpointAPI.update(e.id, { is_active: !e.is_active })
      notify.success(e.is_active ? '已停用' : '已启用')
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  const handleDelete = async (e: SsePublicEndpoint) => {
    if (!confirm(`确定删除对外端点 "${e.slug}"？`)) return
    try {
      await ssePublicEndpointAPI.delete(e.id)
      notify.success('已删除')
      load()
    } catch (err) {
      notify.error(err as Error)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600">
          对外订阅端点：业务前端用 <code className="font-mono text-xs">EventSource</code> 连{' '}
          <code className="font-mono text-xs">{origin || '<平台域名>'}/events/&#123;slug&#125;</code>
          ，身份头由网关注入；topic 必含 <code className="font-mono text-xs">{'{identity}'}</code> 保证只能订自己的。
        </p>
        <button onClick={openCreate} className="btn-primary whitespace-nowrap flex-shrink-0">
          <i className="fas fa-plus mr-2"></i>
          新建对外端点
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <i className="fas fa-spinner fa-spin text-2xl text-gray-400"></i>
          </div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <i className="fas fa-rss text-4xl mb-4 text-gray-300"></i>
            <p className="mb-4">暂无对外端点</p>
            <button onClick={openCreate} className="btn-primary">
              <i className="fas fa-plus mr-2"></i>
              新建第一个端点
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map((e) => (
              <div
                key={e.id}
                className={`px-6 py-4 flex items-center justify-between hover:bg-gray-50 ${
                  !e.is_active ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start space-x-4 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      e.is_active ? 'bg-teal-100' : 'bg-gray-100'
                    }`}
                  >
                    <i className={`fas fa-rss ${e.is_active ? 'text-teal-600' : 'text-gray-400'}`}></i>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-gray-900 truncate">{e.name}</p>
                      <span className="px-2 py-0.5 rounded text-xs font-mono bg-teal-50 text-teal-700">
                        /events/{e.slug}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 font-mono">
                        {e.identity_header}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">
                      <i className="fas fa-arrow-right text-gray-300 mr-1"></i>
                      {e.topic_template}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">event: {e.event_name}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 flex-shrink-0">
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      e.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {e.is_active ? '生效中' : '已停用'}
                  </span>
                  <button
                    onClick={() => handleToggle(e)}
                    className={`px-3 py-1 text-sm rounded-lg ${
                      e.is_active ? 'text-yellow-700 hover:bg-yellow-50' : 'text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {e.is_active ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => openEdit(e)}
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(e)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Drawer
        isOpen={drawerOpen}
        onClose={closeDrawer}
        title={editingId == null ? '新建对外端点' : `编辑对外端点 #${editingId}`}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button
              onClick={closeDrawer}
              disabled={saving}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button onClick={handleSave} disabled={saving} className="flex-1 btn-primary disabled:opacity-50">
              {saving ? '保存中...' : editingId == null ? '创建' : '保存'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              slug（URL 路径）<span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={(ev) => setForm({ ...form, slug: ev.target.value })}
              placeholder="growth-animation"
              className="w-full input-base font-mono text-sm"
              maxLength={64}
              disabled={editingId != null}
            />
            <p className="mt-1 text-xs text-gray-400 break-all">
              订阅地址：{origin || '<平台域名>'}/events/{form.slug || '<slug>'}（仅小写字母/数字/连字符）
              {editingId != null && '；slug 不可改'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(ev) => setForm({ ...form, name: ev.target.value })}
              placeholder="成长动画"
              className="w-full input-base"
              maxLength={100}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              身份头 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.identity_header}
              onChange={(ev) => setForm({ ...form, identity_header: ev.target.value })}
              placeholder="X-Way-UID"
              className="w-full input-base font-mono text-sm"
              maxLength={64}
            />
            <p className="mt-1 text-xs text-gray-400">网关注入的可信请求头，作为连接身份。</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              topic 模板 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.topic_template}
              onChange={(ev) => setForm({ ...form, topic_template: ev.target.value })}
              placeholder="way:{identity}:growth:{query.projectId}"
              className="w-full input-base font-mono text-xs"
            />
            <p className="mt-1 text-xs text-gray-400">
              必含 <code className="font-mono">{'{identity}'}</code>（且排在所有{' '}
              <code className="font-mono">{'{query.X}'}</code> 之前）；<code className="font-mono">{'{query.X}'}</code>{' '}
              取 URL 参数，缺省时退化为末尾通配 <code className="font-mono">*</code>。
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              SSE event 名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.event_name}
              onChange={(ev) => setForm({ ...form, event_name: ev.target.value })}
              placeholder="growth_animation_available"
              className="w-full input-base"
              maxLength={100}
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
```

- [ ] **Step 2: 工作区页加 tab**

Modify `frontend-nextjs/app/workspace/[projectId]/automation/sse-routes/page.tsx`：
- import：`import SsePublicEndpointPanel from '@/components/sse/SsePublicEndpointPanel'`
- tab 类型加 `'endpoints'`：`useState<'rules' | 'bridges' | 'endpoints' | 'monitor'>('rules')`
- tab 数组加项（在 `bridges` 与 `monitor` 之间）：`{ id: 'endpoints' as const, label: '对外端点' },`
- 渲染分支（在 `tab === 'bridges'` 分支之后）：

```tsx
      ) : tab === 'endpoints' ? (
        <SsePublicEndpointPanel tenantId={tenantId} />
```

- [ ] **Step 3: dashboard 页加 tab**

Modify `frontend-nextjs/app/dashboard/sse-routes/page.tsx`：
- import：`import SsePublicEndpointPanel from '@/components/sse/SsePublicEndpointPanel'`
- tab 类型加 `'endpoints'`
- tab 数组加 `{ id: 'endpoints', label: '对外端点' },`
- 渲染：`{tab === 'endpoints' && <SsePublicEndpointPanel />}`

- [ ] **Step 4: typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`
Expected: 仅剩历史 `table-designer`/`TableEditor` + （未修的）`SseMonitorPanel` 报错；新面板与两页无新报错。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/sse/SsePublicEndpointPanel.tsx frontend-nextjs/app/workspace/[projectId]/automation/sse-routes/page.tsx frontend-nextjs/app/dashboard/sse-routes/page.tsx
git commit -m "feat(sse): add public endpoint CRUD panel + tabs"
```

---

## Task 10: 监控面板按端点聚合

**Files:**
- Modify: `frontend-nextjs/components/sse/SseMonitorPanel.tsx`

- [ ] **Step 1: 改连接卡片与聚合区**

把 `SseMonitorPanel.tsx` 里引用 `c.growth` / `c.by_project` / “成长动画连接” 的部分改为按端点：

指标卡数组改为：

```tsx
        {[
          { label: '在线连接', value: c.total },
          { label: '对外端点连接', value: c.public },
          { label: '通用 /sse 连接', value: c.generic },
          { label: '累计推送', value: stats.pushes_total },
        ].map((m) => (
```

底部聚合区（原“成长动画连接（按社区）”）替换为：

```tsx
      {c.by_endpoint.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">对外端点连接（按端点）</h3>
          <div className="flex flex-wrap gap-2">
            {c.by_endpoint.map((p) => (
              <span
                key={p.slug}
                className="px-3 py-1 rounded-full text-xs bg-teal-50 text-teal-700"
              >
                /events/{p.slug}：{p.count}
              </span>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 2: typecheck**

Run: `cd frontend-nextjs && npx tsc --noEmit`
Expected: 仅剩历史 `table-designer`/`TableEditor` 报错；SSE 相关全部清零。

- [ ] **Step 3: Commit**

```bash
git add frontend-nextjs/components/sse/SseMonitorPanel.tsx
git commit -m "feat(sse): aggregate monitor connections by endpoint slug"
```

---

## Task 11: 文档同步 + 全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-06-01-growth-animation-frontend-reference.md`（端点 URL 改为 `/events/growth-animation`）
- Modify: `frontend-nextjs/components/sse/SseNotifyBridgePanel.tsx`（成长动画示例里的订阅地址，line 中 `growth-animation/events` → `/events/growth-animation`）

- [ ] **Step 1: 改前端参考文档**

将 `growth-animation-frontend-reference.md` 内所有 `GET /growth-animation/events?projectId=` 出现处改为 `GET /events/growth-animation?projectId=`，并补一句说明：成长动画现为通用对外端点的一个配置（slug=`growth-animation`）。

- [ ] **Step 2: 改监听桥面板里的示例地址**

在 `SseNotifyBridgePanel.tsx` 成长动画示例块里，把 `GET /growth-animation/events` 改为 `GET /events/growth-animation`。

- [ ] **Step 3: 全量验证**

Run:
```bash
cargo test --bin onebase sse:: && cargo check
cd frontend-nextjs && npx tsc --noEmit
```
Expected: 后端测试 PASS、`cargo check` 仅历史 warning；前端仅 `table-designer`/`TableEditor` 历史报错。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-01-growth-animation-frontend-reference.md frontend-nextjs/components/sse/SseNotifyBridgePanel.tsx
git commit -m "docs(sse): point growth animation at generic /events/growth-animation"
```

---

## Self-Review（已执行）

- **Spec 覆盖**：§4 决策 → Task 2（topic 规则）、Task 5（透传/身份头）、Task 7（URL）；§5.1 表 → Task 1；§5.2 handler → Task 5；§5.3 校验 → Task 2 + Task 6；§6 安全（`{identity}` 在前）→ Task 2 校验 + 测试；§7 监控通用化 → Task 3 + Task 10；§8 删代码/迁移 → Task 4 + Task 11；§9 测试 → Task 2 单测。全部有对应任务。
- **占位符扫描**：无 TBD/TODO；每个改代码步骤均给出完整代码。
- **类型一致性**：`validate_topic_template` / `render_subscription_topic`（Task 2，pub）被 Task 6 引用；`ConnMeta { kind, endpoint_slug, identity, connected_at }`（Task 3）被 Task 5 handler 使用；stats 返回 `connections.{total,public,generic,by_endpoint}`（Task 3）与前端类型（Task 8）、监控面板（Task 10）一致；`ssePublicEndpointAPI`（Task 8）被面板（Task 9）使用。
- **依赖顺序**：Task 3 与 Task 4 必须连续执行后再编译（ConnMeta 改字段会令旧 growth handler 暂时编译失败），计划已显式注明。
