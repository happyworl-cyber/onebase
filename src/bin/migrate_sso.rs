//! 迁移脚本：SSO 社交登录数据表
//!
//! 运行方式: `cargo run --bin migrate_sso`

use onebase::migrate::run_sql_script;
use sqlx::postgres::PgPoolOptions;
use std::env;

const SQL: &str = include_str!("../../migrations/006_sso_providers.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    println!("正在连接数据库...");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    println!("连接成功，开始 SSO 迁移...\n");

    let stats = run_sql_script(&pool, "006 SSO providers", SQL).await;

    if stats.has_error() {
        eprintln!(
            "\n迁移失败：执行 {} 条，跳过 {} 条，错误 {} 条",
            stats.ok, stats.skipped, stats.errors
        );
        std::process::exit(1);
    }

    println!(
        "\n✅ SSO 数据表迁移完成（执行 {}，幂等跳过 {}）",
        stats.ok, stats.skipped
    );
    println!("   - management.sso_providers");
    println!("   - management.sso_user_links");
    println!("   - management.sso_states");

    Ok(())
}
