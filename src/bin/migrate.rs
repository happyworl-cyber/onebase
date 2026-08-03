//! 迁移脚本：基础 users 表
//!
//! 运行方式: `cargo run --bin migrate`

use onebase::migrate::run_sql_script;
use sqlx::postgres::PgPoolOptions;
use std::env;

const SQL: &str = include_str!("../../migrations/001_create_users_table.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set in .env file");

    println!("🔌 连接到数据库: {}", database_url);

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("✅ 数据库连接成功");
    println!("📝 执行迁移脚本...\n");

    let stats = run_sql_script(&pool, "001 users table", SQL).await;

    if stats.has_error() {
        eprintln!(
            "\n❌ 迁移失败：执行 {}，跳过 {}，错误 {}",
            stats.ok, stats.skipped, stats.errors
        );
        std::process::exit(1);
    }

    println!(
        "✅ 迁移完成！（执行 {}，幂等跳过 {}）",
        stats.ok, stats.skipped
    );

    Ok(())
}
