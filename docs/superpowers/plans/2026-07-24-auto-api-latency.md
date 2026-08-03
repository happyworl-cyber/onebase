# Auto API List Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Auto API list latency by deduplicating `cr_` `api_keys` lookups and skipping unnecessary `COUNT(*)` on list reads.

**Architecture:** Enrich `ApiKeyContext` once in `auth_middleware`, then short-circuit slug resolve / RBAC / `validate_auth`. In `list_records`, parse `Prefer: count=...`, run `SELECT` first, and only `COUNT(*)` when exact total is required and the page is full.

**Tech Stack:** Rust, Axum, sqlx, PostgREST-compatible Prefer headers.

**Spec:** `docs/superpowers/specs/2026-07-24-auto-api-latency-design.md`

## Global Constraints

- Single `cr_` request may query `management.api_keys` at most once (in `auth_middleware`)
- Default Prefer count mode is `exact` (backward compatible)
- `count=planned` / `count=estimated` behave as `exact` this iteration
- No DB migration
- JWT RBAC path query pattern unchanged
- Do not merge `set_config` with business SQL in this plan

---

## File map

| File | Responsibility |
|------|----------------|
| `src/auto_api_handlers.rs` | Prefer count parse/decide helpers; list SELECT-then-COUNT; `validate_auth` short-circuit; unit tests |
| `src/middleware.rs` | Extend `ApiKeyContext`; load `permissions` + `bound_slug` in `authenticate_cr_api_key`; slug resolve short-circuit |
| `src/rbac_middleware.rs` | `cr_` branch use `ApiKeyContext.permissions` when present |
| `docs/superpowers/specs/2026-07-24-auto-api-latency-design.md` | Mark status implemented when done |

---

### Task 1: Prefer count helpers + unit tests

**Files:**
- Modify: `src/auto_api_handlers.rs` (near `parse_prefer_resolution` ~1375; tests module ~2816)
- Test: `src/auto_api_handlers.rs` `mod tests`

**Interfaces:**
- Consumes: `axum::http::HeaderMap`
- Produces:
  - `enum CountPreference { Exact, None }`
  - `fn parse_prefer_count(headers: &HeaderMap) -> CountPreference`
  - `enum TotalDecision { Known(Option<i64>), NeedCount }`
  - `fn decide_list_total(prefer: CountPreference, offset: i64, limit: i64, returned: usize) -> TotalDecision`

- [ ] **Step 1: Write failing unit tests**

Add to `mod tests` in `src/auto_api_handlers.rs`:

```rust
#[test]
fn prefer_count_parsing() {
    let mut h = HeaderMap::new();
    assert_eq!(parse_prefer_count(&h), CountPreference::Exact);

    h.insert("prefer", "count=none".parse().unwrap());
    assert_eq!(parse_prefer_count(&h), CountPreference::None);

    h.insert("prefer", "COUNT=Exact".parse().unwrap());
    assert_eq!(parse_prefer_count(&h), CountPreference::Exact);

    h.insert(
        "prefer",
        "return=representation, count=planned".parse().unwrap(),
    );
    assert_eq!(parse_prefer_count(&h), CountPreference::Exact);

    h.insert("prefer", "count=estimated".parse().unwrap());
    assert_eq!(parse_prefer_count(&h), CountPreference::Exact);

    h.insert("prefer", "count=none, count=exact".parse().unwrap());
    // last matching count=* wins (scan left-to-right, overwrite)
    assert_eq!(parse_prefer_count(&h), CountPreference::Exact);
}

#[test]
fn decide_list_total_skips_count_when_page_not_full() {
    assert_eq!(
        decide_list_total(CountPreference::Exact, 0, 100, 3),
        TotalDecision::Known(Some(3))
    );
    assert_eq!(
        decide_list_total(CountPreference::Exact, 10, 100, 3),
        TotalDecision::Known(Some(13))
    );
    assert_eq!(
        decide_list_total(CountPreference::Exact, 0, 100, 100),
        TotalDecision::NeedCount
    );
    assert_eq!(
        decide_list_total(CountPreference::None, 0, 100, 3),
        TotalDecision::Known(None)
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test prefer_count_parsing decide_list_total_skips_count --lib`

Expected: FAIL (types/functions not found)

- [ ] **Step 3: Implement helpers**

Place next to `parse_prefer_resolution`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CountPreference {
    /// Default / exact / planned / estimated — need a precise total when possible.
    Exact,
    /// Prefer: count=none — never run COUNT(*).
    None,
}

fn parse_prefer_count(headers: &HeaderMap) -> CountPreference {
    let Some(raw) = headers.get("prefer").and_then(|v| v.to_str().ok()) else {
        return CountPreference::Exact;
    };
    let mut result = CountPreference::Exact;
    for part in raw.split(',') {
        let part = part.trim();
        let Some(rest) = part
            .split_once('=')
            .filter(|(k, _)| k.eq_ignore_ascii_case("count"))
            .map(|(_, v)| v.trim())
        else {
            continue;
        };
        if rest.eq_ignore_ascii_case("none") {
            result = CountPreference::None;
        } else if rest.eq_ignore_ascii_case("exact")
            || rest.eq_ignore_ascii_case("planned")
            || rest.eq_ignore_ascii_case("estimated")
        {
            result = CountPreference::Exact;
        }
        // unknown count=* values ignored (keep previous)
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TotalDecision {
    /// `Some(n)` = exact total; `None` = unknown (`*` in Content-Range).
    Known(Option<i64>),
    NeedCount,
}

fn decide_list_total(
    prefer: CountPreference,
    offset: i64,
    limit: i64,
    returned: usize,
) -> TotalDecision {
    match prefer {
        CountPreference::None => TotalDecision::Known(None),
        CountPreference::Exact => {
            let returned = returned as i64;
            if returned < limit {
                TotalDecision::Known(Some(offset.saturating_add(returned)))
            } else {
                TotalDecision::NeedCount
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test prefer_count_parsing decide_list_total_skips_count --lib`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auto_api_handlers.rs
git commit -m "$(cat <<'EOF'
feat(auto-api): add Prefer count helpers for list totals

EOF
)"
```

---

### Task 2: Wire `list_records` SELECT-then-conditional-COUNT

**Files:**
- Modify: `src/auto_api_handlers.rs` (`list_records` ~1002–1065; `list_records_pgrest` already maps `count` → `Content-Range`)

**Interfaces:**
- Consumes: `parse_prefer_count`, `decide_list_total` from Task 1
- Produces: `ApiResponse.count` is `Some(total)` for exact, `None` for `count=none` (pgrest already renders `*`)

- [ ] **Step 1: Reorder list transaction body**

In `list_records`, after building `count_sql` / `sql` / binds:

1. `let count_pref = parse_prefer_count(&headers);`
2. Begin tx + `inject_session_user_id` (unchanged)
3. Run **data** `SELECT` (`fetch_all`) first
4. `let decision = decide_list_total(count_pref, offset, limit, rows.len());`
5. Match:
   - `Known(total)` → `total_count = total` (`Option<i64>`)
   - `NeedCount` → run existing COUNT bind/fetch; on error return `AppError::Database` (do **not** swallow)
6. Commit
7. `ApiResponse { data, count: total_count, error: None }`

Skeleton (replace the current count-then-select block):

```rust
let count_pref = parse_prefer_count(&headers);

let mut tx = pool.begin().await.map_err(AppError::Database)?;
inject_session_user_id(&mut tx, user_id_from_claims(&claims)).await?;

let mut query = sqlx::query(&sql);
for spec in &filter_binds {
    query = apply_bind(query, spec);
}
for value in &rbac_binds {
    query = bind_inferred(query, value);
}

let query_start = std::time::Instant::now();
let rows = match query.fetch_all(&mut *tx).await {
    Ok(r) => {
        cb_record_success(&cb_mgr, database_id);
        r
    }
    Err(e) => {
        cb_record_failure(&cb_mgr, database_id);
        return Err(AppError::Database(e));
    }
};

let total_count: Option<i64> = match decide_list_total(count_pref, offset, limit, rows.len()) {
    TotalDecision::Known(v) => v,
    TotalDecision::NeedCount => {
        let mut count_query = sqlx::query(&count_sql);
        for spec in &filter_binds {
            count_query = apply_bind(count_query, spec);
        }
        for value in &rbac_binds {
            count_query = bind_inferred(count_query, value);
        }
        match count_query.fetch_one(&mut *tx).await {
            Ok(r) => Some(r.get::<i64, _>("count")),
            Err(e) => {
                cb_record_failure(&cb_mgr, database_id);
                tracing::warn!(
                    schema = %schema,
                    table = %table,
                    "COUNT(*) 查询失败，整个请求按失败返回；SQL: {} ; err: {}",
                    count_sql,
                    e
                );
                return Err(AppError::Database(e));
            }
        }
    }
};

tx.commit().await.map_err(AppError::Database)?;
let query_ms = query_start.elapsed().as_millis() as i32;
// ... SlowQueryLogger, results, ApiResponse { count: total_count, ... }
```

Keep `tracing::debug!` when skipping COUNT, e.g. `target: "auto_api", "skip COUNT(*) (page not full or count=none)"`.

- [ ] **Step 2: Confirm pgrest Content-Range still correct**

`list_records_pgrest` already does:

```rust
let total_str = count.map(|n| n.to_string()).unwrap_or_else(|| "*".to_string());
```

No change required if `count=None` for `count=none`. Manually sanity-check the mapping in code review.

- [ ] **Step 3: Compile + unit tests**

Run: `cargo test prefer_count_parsing decide_list_total_skips_count --lib && cargo check`

Expected: PASS / success

- [ ] **Step 4: Commit**

```bash
git add src/auto_api_handlers.rs
git commit -m "$(cat <<'EOF'
feat(auto-api): select first and skip COUNT when page not full

EOF
)"
```

---

### Task 3: Extend `ApiKeyContext` + load once in auth

**Files:**
- Modify: `src/middleware.rs` (`ApiKeyContext` ~19–24; `authenticate_cr_api_key` ~30–130)

**Interfaces:**
- Consumes: `management.api_keys`, `management.tenant_databases`
- Produces: `ApiKeyContext { key_id, tenant_id, database_id, permissions: serde_json::Value, bound_slug: String }`

- [ ] **Step 1: Extend struct + SQL**

```rust
#[derive(Debug, Clone)]
pub struct ApiKeyContext {
    pub key_id: i32,
    pub tenant_id: i32,
    pub database_id: i32,
    pub permissions: serde_json::Value,
    pub bound_slug: String,
}
```

Update `authenticate_cr_api_key` SELECT to join active tenant DB and select permissions/slug:

```sql
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
```

Fill context:

```rust
let permissions: serde_json::Value = row
    .try_get("permissions")
    .unwrap_or_else(|_| serde_json::json!({}));
let bound_slug: String = row.get("bound_slug");
let ctx = ApiKeyContext {
    key_id,
    tenant_id,
    database_id,
    permissions,
    bound_slug,
};
```

Update the doc comment on `ApiKeyContext`: downstream **must** reuse this context and must not re-query `api_keys` for the same request.

Keep the existing `tokio::spawn` throttled `last_used_at` update.

- [ ] **Step 2: Compile**

Run: `cargo check`

Expected: success (only construction site is this file today)

- [ ] **Step 3: Commit**

```bash
git add src/middleware.rs
git commit -m "$(cat <<'EOF'
feat(auth): load api key permissions and slug once into context

EOF
)"
```

---

### Task 4: Short-circuit slug resolve, RBAC, and `validate_auth`

**Files:**
- Modify: `src/middleware.rs` (`resolve_database_id_from_slug`, `auto_api_database_slug_middleware`)
- Modify: `src/rbac_middleware.rs` (`rbac_middleware` `cr_` branch ~137–217)
- Modify: `src/auto_api_handlers.rs` (`validate_auth` + all call sites)

**Interfaces:**
- Consumes: `ApiKeyContext` from Task 3
- Produces:
  - `fn auth_from_api_key_context(ctx: &ApiKeyContext, path_database_id: i32) -> Result<(i32, AuthSource)>`
  - `validate_auth(..., api_key_ctx: Option<&ApiKeyContext>)`
  - slug/rbac paths that skip SQL when context present

- [ ] **Step 1: Write failing unit tests for auth short-circuit helper**

In `auto_api_handlers.rs` tests:

```rust
#[test]
fn auth_from_api_key_context_matches_db() {
    let ctx = crate::middleware::ApiKeyContext {
        key_id: 1,
        tenant_id: 2,
        database_id: 5,
        permissions: serde_json::json!({}),
        bound_slug: "uba".into(),
    };
    let (id, src) = auth_from_api_key_context(&ctx, 5).unwrap();
    assert_eq!(id, 5);
    assert!(matches!(src, AuthSource::ApiKey));
    assert!(auth_from_api_key_context(&ctx, 9).is_err());
}
```

- [ ] **Step 2: Run test to verify fail**

Run: `cargo test auth_from_api_key_context_matches_db --lib`

Expected: FAIL

- [ ] **Step 3: Implement `auth_from_api_key_context` + update `validate_auth`**

```rust
fn auth_from_api_key_context(
    ctx: &crate::middleware::ApiKeyContext,
    path_database_id: i32,
) -> Result<(i32, AuthSource)> {
    if ctx.database_id != path_database_id {
        return Err(AppError::Unauthorized("API Key 与数据库不匹配".to_string()));
    }
    Ok((ctx.database_id, AuthSource::ApiKey))
}

async fn validate_auth(
    main_pool: &PgPool,
    headers: &HeaderMap,
    path_database_id: i32,
    has_jwt: bool,
    api_key_ctx: Option<&crate::middleware::ApiKeyContext>,
) -> Result<(i32, AuthSource)> {
    if let Some(ctx) = api_key_ctx {
        return auth_from_api_key_context(ctx, path_database_id);
    }

    // existing Bearer cr_ DB lookup path, but DELETE the synchronous
    // UPDATE management.api_keys SET last_used_at = NOW() block entirely.
    // ...
}
```

Update **every** `validate_auth(...)` call site in this file to accept optional context. Pattern for each handler:

```rust
api_key_ctx: Option<axum::extract::Extension<crate::middleware::ApiKeyContext>>,
// ...
validate_auth(
    &main_pool,
    &headers,
    database_id,
    claims.is_some(),
    api_key_ctx.as_ref().map(|e| &e.0),
)
.await?;
```

Handlers that call `validate_auth` today: `list_records`, get-by-id, create, patch, delete, and any bulk variants in the same file (grep `validate_auth(` and update all).

- [ ] **Step 4: Short-circuit slug resolve**

Change signature:

```rust
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
    // existing api_key / JWT branches unchanged
    ...
}
```

In `auto_api_database_slug_middleware`, pass:

```rust
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
```

- [ ] **Step 5: Short-circuit `rbac_middleware` cr_ branch**

At the start of the `if let Some(api_key) = api_key` block, before the SQL:

```rust
if let Some(ctx) = req.extensions().get::<crate::middleware::ApiKeyContext>().cloned() {
    if ctx.database_id != database_id {
        return Err(AppError::Unauthorized("API Key 与数据库不匹配".to_string()));
    }
    if let Some(header_db_id) = req
        .headers()
        .get("X-Database-Id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<i32>().ok())
    {
        if ctx.database_id != header_db_id {
            return Err(AppError::Forbidden(
                "API key does not have access to this database".to_string(),
            ));
        }
    }
    check_api_key_scope(&ctx.permissions, &resource, action, &schema)?;
    req.extensions_mut().insert(PermissionResult {
        allowed: true,
        row_conditions: vec![],
        allowed_columns: None,
        is_superadmin: false,
    });
    return Ok(next.run(req).await);
}
// fallback: existing SQL lookup for environments without auth-injected context
```

Keep the fallback query for safety when middleware order differs in tests.

- [ ] **Step 6: Run tests + check**

Run:

```bash
cargo test auth_from_api_key_context_matches_db prefer_count_parsing decide_list_total --lib
cargo check
```

Expected: PASS / success

- [ ] **Step 7: Commit**

```bash
git add src/middleware.rs src/rbac_middleware.rs src/auto_api_handlers.rs
git commit -m "$(cat <<'EOF'
feat(auth): reuse ApiKeyContext to skip duplicate api_keys queries

EOF
)"
```

---

### Task 5: Verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-auto-api-latency-design.md` (status line)

- [ ] **Step 1: Run focused + broader lib tests**

```bash
cargo test prefer_count decide_list_total auth_from_api_key_context --lib
cargo test parse_prefer --lib
cargo check
```

Expected: all PASS / success

- [ ] **Step 2: Manual checklist (prod-like)**

Against a staging/prod-like env with the slow URL shape:

1. `cr_` + slug URL, no Prefer → response still has exact total when rows < limit; `elapsed_ms` drops vs baseline
2. `Prefer: count=none` → `Content-Range` ends with `/*`, body `count` absent/null
3. Force full page (`limit` ≤ returned rows) → still returns exact total (COUNT path)
4. Wrong slug vs key → same Forbidden message as before

- [ ] **Step 3: Update spec status**

Set first line status to: `状态：已实现`

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-24-auto-api-latency-design.md
git commit -m "$(cat <<'EOF'
docs: mark Auto API latency design implemented

EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| `api_keys` queried once per `cr_` request | Task 3 + 4 |
| Extend `ApiKeyContext` with permissions + bound_slug | Task 3 |
| slug / rbac / validate_auth short-circuit | Task 4 |
| Remove sync `last_used_at` UPDATE in validate_auth | Task 4 |
| Prefer count default exact | Task 1 |
| Skip COUNT when page not full | Task 1 + 2 |
| `count=none` → no COUNT / `*` | Task 1 + 2 |
| planned/estimated = exact | Task 1 |
| SELECT before COUNT | Task 2 |
| No migration / JWT path unchanged | Tasks 3–4 (JWT branches untouched) |
| Unit tests for Prefer + short-circuit helper | Tasks 1, 4 |
| Manual elapsed_ms check | Task 5 |
