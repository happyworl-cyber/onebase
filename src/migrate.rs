//! 数据库迁移共享工具
//!
//! 主要解决两件事：
//!
//! 1. **正确切分 SQL**：`str::split(';')` 在 PostgreSQL 场景下有三个坑——
//!    `--` 行注释会把后续语句整段吃掉、`$$ ... $$` 美元引用块（plpgsql 函数体）
//!    里的 `;` 会被误切、`'...'` 字符串字面量里的 `;` 同样会被误切。
//!    `split_sql_statements` 是个微型 SQL 词法器，能正确处理这三种情况。
//!
//! 2. **统一的 runner**：`run_sql_script` 逐条执行切分后的语句，
//!    把"已存在 / 重复键"等幂等再跑可能产生的良性错误识别为 `skipped`，
//!    其他错误打印到 stderr 并累积到 `MigrationStats.errors` 中由调用方决定是否中止。

use sqlx::PgPool;

/// 迁移执行统计
#[derive(Debug, Default, Clone, Copy)]
pub struct MigrationStats {
    pub ok: usize,
    pub skipped: usize,
    pub errors: usize,
}

impl MigrationStats {
    pub fn has_error(&self) -> bool {
        self.errors > 0
    }
}

/// 运行一段 SQL 脚本（多语句），按统一规则统计 ok / skipped / errors。
///
/// - `name` 仅用于错误日志前缀，便于定位是哪个迁移文件。
/// - 切分逻辑见 [`split_sql_statements`]。
/// - 良性错误（"already exists" / "duplicate key" / "IF NOT EXISTS"）→ `skipped`。
/// - 其他错误 → 打印到 stderr，并累计到 `errors` 中，但**不中止**整段脚本。
///   调用方可以根据 `stats.has_error()` 决定是否 `process::exit(1)`。
pub async fn run_sql_script(pool: &PgPool, name: &str, sql: &str) -> MigrationStats {
    let mut stats = MigrationStats::default();

    for stmt in split_sql_statements(sql) {
        if stmt.is_empty() {
            continue;
        }
        match sqlx::query(&stmt).execute(pool).await {
            Ok(_) => stats.ok += 1,
            Err(e) => {
                let msg = e.to_string();
                let is_benign = msg.contains("already exists")
                    || msg.contains("duplicate key")
                    || msg.contains("IF NOT EXISTS");
                if is_benign {
                    stats.skipped += 1;
                } else {
                    eprintln!("    [{}] ERROR: {}", name, msg);
                    stats.errors += 1;
                }
            }
        }
    }

    stats
}

/// 管理库的完整迁移序列（编号 SQL 文件，按顺序幂等执行）。
///
/// **单一信源**：`migrate_all` binary 与 app 启动期自动迁移都走这张表，改迁移
/// 只动这一处。`include_str!` 在编译期把 SQL 内联进二进制，运行时不依赖
/// `migrations/` 目录存在（容器里可以不打包 SQL 文件）。
///
/// 注意：013_rls_helpers 是给业务库（tenant database）跑的，不在管理库范围内，
/// 故意不收录。
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001 users table",
        include_str!("../migrations/001_create_users_table.sql"),
    ),
    (
        "003 management schema",
        include_str!("../migrations/003_create_management_schema.sql"),
    ),
    (
        "004 superadmin role",
        include_str!("../migrations/004_add_superadmin_role.sql"),
    ),
    (
        "005 RBAC tables",
        include_str!("../migrations/005_rbac_tables.sql"),
    ),
    (
        "006 SSO providers",
        include_str!("../migrations/006_sso_providers.sql"),
    ),
    (
        "007 read replicas",
        include_str!("../migrations/007_read_replicas.sql"),
    ),
    (
        "008 webhooks",
        include_str!("../migrations/008_webhooks.sql"),
    ),
    (
        "009 audit logs",
        include_str!("../migrations/009_audit_logs.sql"),
    ),
    (
        "010 gateway config",
        include_str!("../migrations/010_gateway_config.sql"),
    ),
    (
        "011 default permissions",
        include_str!("../migrations/011_seed_default_permissions.sql"),
    ),
    (
        "012 jwt sessions",
        include_str!("../migrations/012_jwt_sessions.sql"),
    ),
    (
        "014 scheduled tasks",
        include_str!("../migrations/014_scheduled_tasks.sql"),
    ),
    (
        "015 scheduled tasks shell",
        include_str!("../migrations/015_scheduled_tasks_shell.sql"),
    ),
    (
        "016 es proxy",
        include_str!("../migrations/016_es_proxy.sql"),
    ),
    (
        "017 scheduled tasks shell tenant",
        include_str!("../migrations/017_scheduled_tasks_shell_tenant.sql"),
    ),
    (
        "018 workspace kind",
        include_str!("../migrations/018_workspace_kind.sql"),
    ),
    (
        "019 pg pools + templates",
        include_str!("../migrations/019_pg_pools_and_templates.sql"),
    ),
    (
        "020 scheduled tasks timeout 24h",
        include_str!("../migrations/020_scheduled_tasks_timeout_24h.sql"),
    ),
    (
        "021 session rules",
        include_str!("../migrations/021_session_rules.sql"),
    ),
    (
        "022 workflows",
        include_str!("../migrations/022_workflows.sql"),
    ),
    (
        "023 sse routes",
        include_str!("../migrations/023_sse_routes.sql"),
    ),
    (
        "024 sse notify bridges",
        include_str!("../migrations/024_sse_notify_bridges.sql"),
    ),
    (
        "025 sse public endpoints",
        include_str!("../migrations/025_sse_public_endpoints.sql"),
    ),
    (
        "026 workflow db slug",
        include_str!("../migrations/026_workflow_database_slug.sql"),
    ),
    (
        "027 strip primary slug suffix",
        include_str!("../migrations/027_strip_primary_slug_suffix.sql"),
    ),
    (
        "028 workflow category",
        include_str!("../migrations/028_workflow_category.sql"),
    ),
    (
        "029 workflow versions",
        include_str!("../migrations/029_workflow_versions.sql"),
    ),
    (
        "030 mcp personal access tokens",
        include_str!("../migrations/030_mcp_personal_access_tokens.sql"),
    ),
    (
        "031 project env vars",
        include_str!("../migrations/031_project_env_vars.sql"),
    ),
    (
        "032 sso mind provider",
        include_str!("../migrations/032_sso_mind_provider.sql"),
    ),
    (
        "033 sso provider auto role",
        include_str!("../migrations/033_sso_provider_auto_role.sql"),
    ),
    (
        "034 sso states pkce",
        include_str!("../migrations/034_sso_states_pkce.sql"),
    ),
    // 注意：存在两个「030」是两条 feature 分支合并的产物（personal_access_tokens
    // 与 platform_tokens 是两套不同的令牌表，详见 main.rs 路由注册处的对照说明）。
    // 编号重复无害——运行器按顺序跑、name 仅用于日志、SQL 自身幂等。
    (
        "030 platform tokens",
        include_str!("../migrations/030_platform_tokens.sql"),
    ),
    (
        "032 workflow taxonomy",
        include_str!("../migrations/032_workflow_taxonomy.sql"),
    ),
    (
        "035 workflow shared uncategorized",
        include_str!("../migrations/035_workflow_shared_uncategorized.sql"),
    ),
    (
        "036 execution logs",
        include_str!("../migrations/036_execution_logs.sql"),
    ),
    (
        "037 tenant databases sort order",
        include_str!("../migrations/037_tenant_databases_sort_order.sql"),
    ),
    (
        "041 idp foundation",
        include_str!("../migrations/041_idp_foundation.sql"),
    ),
    (
        "042 idp oidc runtime",
        include_str!("../migrations/042_idp_oidc_runtime.sql"),
    ),
    (
        "043 idp sessions",
        include_str!("../migrations/043_idp_sessions.sql"),
    ),
    (
        "044 idp provider config",
        include_str!("../migrations/044_idp_provider_config.sql"),
    ),
    (
        "045 idp login logs",
        include_str!("../migrations/045_idp_login_logs.sql"),
    ),
    (
        "046 workflow datasources",
        include_str!("../migrations/046_workflow_datasources.sql"),
    ),
    (
        "048 workflow cron fires",
        include_str!("../migrations/048_workflow_cron_fires.sql"),
    ),
    (
        "038 users must change password",
        include_str!("../migrations/038_users_must_change_password.sql"),
    ),
    (
        "046 redis connections",
        include_str!("../migrations/046_redis_connections.sql"),
    ),
    (
        "046 workflow doc share",
        include_str!("../migrations/046_workflow_doc_share.sql"),
    ),
    (
        "047 rest api doc share",
        include_str!("../migrations/047_rest_api_doc_share.sql"),
    ),
    (
        "049 alert webhooks",
        include_str!("../migrations/049_alert_webhooks.sql"),
    ),
    (
        "050 platform monitor",
        include_str!("../migrations/050_platform_monitor.sql"),
    ),
    (
        "051 public base settings",
        include_str!("../migrations/051_public_base_settings.sql"),
    ),
    (
        "052 kafka connections",
        include_str!("../migrations/052_kafka_connections.sql"),
    ),
    (
        "053 kafka access tokens",
        include_str!("../migrations/053_kafka_access_tokens.sql"),
    ),
    (
        "054 workflow dependencies",
        include_str!("../migrations/054_workflow_dependencies.sql"),
    ),
    (
        "055 workflow search index",
        include_str!("../migrations/055_workflow_search_index.sql"),
    ),
    (
        "056 operation logs",
        include_str!("../migrations/056_operation_logs.sql"),
    ),
    (
        "057 object storage connections",
        include_str!("../migrations/057_object_storage_connections.sql"),
    ),
    (
        "058 object storage access tokens",
        include_str!("../migrations/058_object_storage_access_tokens.sql"),
    ),
    (
        // 与 feature/optimize 并行时曾占用 057；合并 develop 后改挂 059，避免与对象存储冲突。
        "059 users is_active",
        include_str!("../migrations/059_users_is_active.sql"),
    ),
];

/// API Keys 表（内联 SQL，历史上由独立的 migrate_api_keys 维护，这里随主序列一起跑）。
const API_KEYS_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS management.api_keys (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
        database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        key_hash VARCHAR(128) NOT NULL,
        key_prefix VARCHAR(12) NOT NULL,
        permissions JSONB DEFAULT '{"read": true, "write": true, "delete": true}',
        is_active BOOLEAN DEFAULT true,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(key_hash)
    );
    -- 存量表补列：记录 Key 创建者，ob_ 鉴权时把作者归属到创建者而非租户 owner/admin
    ALTER TABLE management.api_keys ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON management.api_keys(created_by);
    CREATE INDEX IF NOT EXISTS idx_api_keys_database_id ON management.api_keys(database_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash   ON management.api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_active     ON management.api_keys(is_active) WHERE is_active = true;
"#;

/// 跨实例互斥用的 advisory lock key（任意固定常量，只要全集群一致即可）。
/// 取自 "onebase.migrate" 的语义化魔数，避免与业务可能用到的 advisory lock 撞键。
const MIGRATION_LOCK_KEY: i64 = 0x6372_6d67_7261_7465_u64 as i64;

/// 执行完整的管理库迁移序列，**幂等**，可在每次进程启动时安全重复调用。
///
/// 并发安全：进入时先抢一把会话级 `pg_advisory_lock`，多实例同时启动只有一个
/// 真正跑迁移，其余等锁后看到 `IF NOT EXISTS` 全部跳过。锁绑定在一条独占连接上，
/// 函数返回（含出错路径）前一定释放。
///
/// 返回累计 [`MigrationStats`]；调用方据 `has_error()` 决定后续动作（binary 用它
/// 决定 exit code，app 启动用它决定是否告警）。
pub async fn run_all_migrations(pool: &PgPool) -> Result<MigrationStats, sqlx::Error> {
    // 独占一条连接持有 advisory lock：锁是会话级的，必须 lock/unlock 同连接。
    // 迁移本身仍在 pool 的其它连接上跑，不受影响。
    let mut lock_conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *lock_conn)
        .await?;

    let result = run_all_inner(pool).await;

    // 无论迁移成功与否都要解锁，否则这条连接归还池后锁仍被持有，下个实例永久等待。
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *lock_conn)
        .await;

    Ok(result)
}

/// 实际迁移步骤（已在 advisory lock 保护下调用）。
async fn run_all_inner(pool: &PgPool) -> MigrationStats {
    let mut total = MigrationStats::default();

    // 后续 migration 都依赖 management schema 存在。
    let _ = sqlx::query("CREATE SCHEMA IF NOT EXISTS management")
        .execute(pool)
        .await;

    for (name, sql) in MIGRATIONS {
        let stats = run_sql_script(pool, name, sql).await;
        tracing::info!(
            target: "onebase::migrate",
            step = name, ok = stats.ok, skipped = stats.skipped, errors = stats.errors,
            "迁移步骤完成"
        );
        accumulate(&mut total, &stats);
    }

    let api_keys = run_sql_script(pool, "API keys table", API_KEYS_SQL).await;
    tracing::info!(
        target: "onebase::migrate",
        step = "API keys table", ok = api_keys.ok, skipped = api_keys.skipped, errors = api_keys.errors,
        "迁移步骤完成"
    );
    accumulate(&mut total, &api_keys);

    // users 表向后兼容字段（旧库可能缺）。ADD COLUMN IF NOT EXISTS 自身幂等。
    let _ =
        sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'")
            .execute(pool)
            .await;
    let _ = sqlx::query(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false",
    )
    .execute(pool)
    .await;

    total
}

fn accumulate(total: &mut MigrationStats, step: &MigrationStats) {
    total.ok += step.ok;
    total.skipped += step.skipped;
    total.errors += step.errors;
}

/// 把整段 SQL 切分成独立的 statement 列表。
///
/// 与 `str::split(';')` 的区别：
/// - 正确剥离 `--` 行注释和 `/* */` 块注释（不会把后续语句吃成注释）
/// - 正确处理 `'...'` 单引号字符串（含 `''` 转义）里的 `;`
/// - 正确处理 PostgreSQL 的 `$$ ... $$` / `$tag$ ... $tag$` 美元引用块
///   （函数体里出现的 `;` 不会被当作语句分隔符）
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    enum State {
        Normal,
        SingleQuote,
        DollarQuote(String),
        LineComment,
        BlockComment,
    }

    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut state = State::Normal;
    let mut i = 0;

    while i < n {
        let c = chars[i];
        match &state {
            State::Normal => {
                if c == '\'' {
                    buf.push(c);
                    state = State::SingleQuote;
                    i += 1;
                } else if c == '-' && i + 1 < n && chars[i + 1] == '-' {
                    state = State::LineComment;
                    i += 2;
                } else if c == '/' && i + 1 < n && chars[i + 1] == '*' {
                    state = State::BlockComment;
                    i += 2;
                } else if c == '$' {
                    // 尝试识别 $tag$ 形式（tag 由字母/数字/下划线组成，可为空）
                    let mut j = i + 1;
                    while j < n && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                        j += 1;
                    }
                    if j < n && chars[j] == '$' {
                        let tag: String = chars[i..=j].iter().collect();
                        buf.push_str(&tag);
                        state = State::DollarQuote(tag);
                        i = j + 1;
                    } else {
                        // 不是合法的 $tag$ 起始（例如 bcrypt 的 $2b$ —— tag 合法但
                        // 后面的 $12$ / $...$ 是不同 tag，闭合检测会失败；这里仍按
                        // 普通字符处理，由后续 normal-mode 继续推进）
                        buf.push(c);
                        i += 1;
                    }
                } else if c == ';' {
                    let stmt = buf.trim().to_string();
                    if !stmt.is_empty() {
                        out.push(stmt);
                    }
                    buf.clear();
                    i += 1;
                } else {
                    buf.push(c);
                    i += 1;
                }
            }
            State::SingleQuote => {
                buf.push(c);
                if c == '\'' {
                    if i + 1 < n && chars[i + 1] == '\'' {
                        buf.push('\'');
                        i += 2;
                    } else {
                        state = State::Normal;
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            State::DollarQuote(tag) => {
                let tag = tag.clone();
                let tag_chars: Vec<char> = tag.chars().collect();
                if i + tag_chars.len() <= n && chars[i..i + tag_chars.len()] == tag_chars[..] {
                    buf.push_str(&tag);
                    i += tag_chars.len();
                    state = State::Normal;
                } else {
                    buf.push(c);
                    i += 1;
                }
            }
            State::LineComment => {
                if c == '\n' {
                    buf.push('\n');
                    state = State::Normal;
                }
                i += 1;
            }
            State::BlockComment => {
                if c == '*' && i + 1 < n && chars[i + 1] == '/' {
                    state = State::Normal;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }
    }

    let tail = buf.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strips_leading_line_comment() {
        let sql = "-- 注释\nCREATE TABLE t (id int);";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].contains("CREATE TABLE t"));
        assert!(!parts[0].contains("注释"));
    }

    #[test]
    fn test_keeps_dollar_quoted_function_intact() {
        let sql = r#"
            CREATE FUNCTION f() RETURNS TRIGGER AS $$
            BEGIN
                NEW.x = 1;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TABLE t (id int);
        "#;
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2, "应该正好两条语句，函数体不被切开");
        assert!(parts[0].contains("RETURN NEW"));
        assert!(parts[0].contains("$$ LANGUAGE plpgsql"));
        assert!(parts[1].starts_with("CREATE TABLE"));
    }

    #[test]
    fn test_named_dollar_quote_tag() {
        let sql = "DO $proc$ BEGIN PERFORM 1; END $proc$; SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("$proc$"));
        assert!(parts[1].starts_with("SELECT 1"));
    }

    #[test]
    fn test_semicolon_inside_string_literal() {
        let sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'a;b'"));
        assert!(parts[1].starts_with("SELECT 1"));
    }

    #[test]
    fn test_escaped_quote_in_string() {
        let sql = "INSERT INTO t VALUES ('it''s ok;'); SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'it''s ok;'"));
    }

    #[test]
    fn test_bcrypt_hash_with_dollar_signs() {
        let sql = "INSERT INTO users VALUES ('admin', '$2b$12$abcdef');";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].contains("$2b$12$abcdef"));
    }

    #[test]
    fn test_block_comment_stripped() {
        let sql = "/* hello\n world */ SELECT 1;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].starts_with("SELECT"));
    }

    #[test]
    fn test_inline_comment_after_statement() {
        let sql = "SELECT 1; -- trailing\nSELECT 2;";
        let parts = split_sql_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].starts_with("SELECT 1"));
        assert!(parts[1].starts_with("SELECT 2"));
    }

    #[test]
    fn test_migration_stats_default_no_error() {
        let s = MigrationStats::default();
        assert!(!s.has_error());
        assert_eq!(s.ok, 0);
    }
}
