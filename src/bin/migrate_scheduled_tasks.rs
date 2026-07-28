//! 迁移脚本：定时任务表
//! 运行方式: `cargo run --bin migrate_scheduled_tasks`

use onebase::migrate::run_sql_script;
use sqlx::postgres::PgPoolOptions;
use std::env;

const SQL: &str = include_str!("../../migrations/014_scheduled_tasks.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new().max_connections(5).connect(&database_url).await?;

    println!("📝 创建定时任务表...");
    let stats = run_sql_script(&pool, "014 scheduled tasks", SQL).await;
    if stats.has_error() {
        eprintln!("❌ 迁移失败：执行 {}，跳过 {}，错误 {}", stats.ok, stats.skipped, stats.errors);
        std::process::exit(1);
    }
    println!("✅ 完成（执行 {}，幂等跳过 {}）", stats.ok, stats.skipped);
    Ok(())
}
