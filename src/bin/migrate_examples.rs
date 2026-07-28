//! 迁移脚本：示例业务表（categories / products / orders 等，供 ER 图演示）
//!
//! 运行方式: `cargo run --bin migrate_examples`

use onebase::migrate::run_sql_script;
use sqlx::postgres::PgPoolOptions;
use std::env;

const SQL: &str = include_str!("../../migrations/002_create_example_tables.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url =
        env::var("DATABASE_URL").expect("DATABASE_URL must be set in .env file");

    println!("🔌 连接到数据库: {}", database_url);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    println!("✅ 数据库连接成功\n");

    println!("📝 创建示例表和外键关系...");
    let stats = run_sql_script(&pool, "002 example tables", SQL).await;
    if stats.has_error() {
        eprintln!(
            "\n❌ 迁移失败：执行 {}，跳过 {}，错误 {}",
            stats.ok, stats.skipped, stats.errors
        );
        std::process::exit(1);
    }
    println!(
        "✅ 示例表创建完成（执行 {}，幂等跳过 {}）\n",
        stats.ok, stats.skipped
    );

    println!("📊 创建的表:");
    println!("   - categories (产品分类)");
    println!("   - products (产品) → 外键到 categories");
    println!("   - orders (订单) → 外键到 users");
    println!("   - order_items (订单明细) → 外键到 orders, products");
    println!("   - user_addresses (用户地址) → 外键到 users");
    println!("   - product_reviews (产品评论) → 外键到 users, products");
    println!();
    println!("🎨 现在可以在 ER 图中看到表之间的关系了！");

    Ok(())
}
