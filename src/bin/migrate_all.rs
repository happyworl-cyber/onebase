//! 统一数据库迁移脚本
//!
//! 按顺序执行 `migrations/` 下所有迁移，每步幂等（IF NOT EXISTS / 良性错误跳过）。
//! 运行方式: `cargo run --bin migrate_all`

use onebase::migrate::{run_sql_script, MigrationStats};
use sqlx::postgres::PgPoolOptions;
use std::env;

const MIGRATIONS: &[(&str, &str)] = &[
    ("001 users table",          include_str!("../../migrations/001_create_users_table.sql")),
    ("003 management schema",    include_str!("../../migrations/003_create_management_schema.sql")),
    ("004 superadmin role",      include_str!("../../migrations/004_add_superadmin_role.sql")),
    ("005 RBAC tables",          include_str!("../../migrations/005_rbac_tables.sql")),
    ("006 SSO providers",        include_str!("../../migrations/006_sso_providers.sql")),
    ("007 read replicas",        include_str!("../../migrations/007_read_replicas.sql")),
    ("008 webhooks",             include_str!("../../migrations/008_webhooks.sql")),
    ("009 audit logs",           include_str!("../../migrations/009_audit_logs.sql")),
    ("010 gateway config",       include_str!("../../migrations/010_gateway_config.sql")),
    ("011 default permissions",  include_str!("../../migrations/011_seed_default_permissions.sql")),
    ("012 jwt sessions",         include_str!("../../migrations/012_jwt_sessions.sql")),
    // 013_rls_helpers 是给业务库（tenant database）跑的，不在管理库 migrate_all 范围内。
    ("014 scheduled tasks",      include_str!("../../migrations/014_scheduled_tasks.sql")),
    ("015 scheduled tasks shell", include_str!("../../migrations/015_scheduled_tasks_shell.sql")),
    ("016 es proxy",             include_str!("../../migrations/016_es_proxy.sql")),
    ("017 scheduled tasks shell tenant", include_str!("../../migrations/017_scheduled_tasks_shell_tenant.sql")),
];

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    println!("========================================");
    println!("  OneBase 数据库迁移");
    println!("========================================");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("数据库连接成功\n");

    // 确保 management schema 存在（后续 migration 都依赖）
    let _ = sqlx::query("CREATE SCHEMA IF NOT EXISTS management")
        .execute(&pool)
        .await;

    let mut total_errors = 0;

    for (name, sql) in MIGRATIONS {
        print!("  [{name}] ");
        let stats = run_sql_script(&pool, name, sql).await;
        report(&stats);
        total_errors += stats.errors;
    }

    // API Keys 表（内联 SQL，与独立的 migrate_api_keys 保持一致）
    print!("  [API keys table] ");
    let api_keys_sql = r#"
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
            UNIQUE(key_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_database_id ON management.api_keys(database_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash   ON management.api_keys(key_hash);
        CREATE INDEX IF NOT EXISTS idx_api_keys_active     ON management.api_keys(is_active) WHERE is_active = true;
    "#;
    let stats = run_sql_script(&pool, "API keys table", api_keys_sql).await;
    report(&stats);
    total_errors += stats.errors;

    // users 表向后兼容字段（旧库可能缺）
    print!("  [users.role column] ");
    match sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'")
        .execute(&pool)
        .await
    {
        Ok(_) => println!("OK"),
        Err(_) => println!("skipped (already exists)"),
    }

    let _ = sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false")
        .execute(&pool)
        .await;

    if total_errors > 0 {
        eprintln!("\n迁移过程中出现 {total_errors} 处错误，请检查并修复后重试！");
        std::process::exit(1);
    }

    println!("\n所有迁移执行完毕！");
    Ok(())
}

fn report(stats: &MigrationStats) {
    if stats.has_error() {
        println!(
            "FAILED ({} executed, {} skipped, {} errors)",
            stats.ok, stats.skipped, stats.errors
        );
    } else {
        println!("OK ({} executed, {} skipped)", stats.ok, stats.skipped);
    }
}
