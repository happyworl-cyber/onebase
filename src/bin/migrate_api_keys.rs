//! 迁移脚本：添加 API Keys 表
//!
//! 运行方式: cargo run --bin migrate_api_keys

use sqlx::postgres::PgPoolOptions;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    println!("正在连接数据库...");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("连接成功，开始迁移...");

    // 创建 API Keys 表
    println!("创建 api_keys 表...");
    sqlx::query(r#"
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
        )
    "#)
    .execute(&pool)
    .await?;

    // 存量表补列：记录 Key 创建者（与 migrate.rs 的 API_KEYS_SQL 保持一致）
    sqlx::query(
        "ALTER TABLE management.api_keys ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL",
    )
    .execute(&pool)
    .await?;

    println!("创建索引...");
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_api_keys_database_id ON management.api_keys(database_id)",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON management.api_keys(key_hash)",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_api_keys_active ON management.api_keys(is_active) WHERE is_active = true")
        .execute(&pool)
        .await?;

    println!("✅ API Keys 表迁移完成！");

    Ok(())
}
