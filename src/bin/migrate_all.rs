//! 统一数据库迁移脚本（手动入口）
//!
//! 按顺序执行管理库的全部迁移，每步幂等（IF NOT EXISTS / 良性错误跳过）。
//! 运行方式: `cargo run --bin migrate_all`
//!
//! 迁移序列与"app 启动时自动迁移"共用同一份实现（`onebase::migrate::run_all_migrations`），
//! 因此这里只是一个带 exit code 的薄壳，供 CI/CD 或人工显式触发使用。

use onebase::migrate::run_all_migrations;
use sqlx::postgres::PgPoolOptions;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    // 让 run_all_migrations 内部的 tracing::info! 逐步输出可见（binary 自带的精简 subscriber）。
    tracing_subscriber::fmt()
        .with_target(false)
        .with_level(true)
        .init();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    println!("========================================");
    println!("  OneBase 数据库迁移");
    println!("========================================");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("数据库连接成功\n");

    let stats = run_all_migrations(&pool).await?;

    println!(
        "\n汇总：{} 条执行 / {} 条跳过 / {} 处错误",
        stats.ok, stats.skipped, stats.errors
    );

    if stats.has_error() {
        eprintln!(
            "\n迁移过程中出现 {} 处错误，请检查并修复后重试！",
            stats.errors
        );
        std::process::exit(1);
    }

    println!("\n所有迁移执行完毕！");
    Ok(())
}
