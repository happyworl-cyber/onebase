//! 一键配置多租户系统
//!
//! 等价于 `migrate_management` + 把现有 admin 用户置为 super_admin。
//! 运行方式: `cargo run --bin setup_multi_tenant`

use onebase::migrate::run_sql_script;
use sqlx::{postgres::PgPoolOptions, Row};
use std::env;

const SQL: &str = include_str!("../../migrations/003_create_management_schema.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    println!("🚀 开始配置多租户系统...\n");

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:123456@localhost/onebase".to_string());

    println!("📦 连接数据库: {}", database_url);

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("✅ 数据库连接成功\n");

    // 1. 确保 management schema 存在（003 内部的语句也会做，但这里先建好更直观）
    println!("📋 步骤 1: 创建 management schema...");
    sqlx::query("CREATE SCHEMA IF NOT EXISTS management")
        .execute(&pool)
        .await?;
    println!("✅ Management schema 创建成功\n");

    // 2. 执行多租户表结构迁移（走共享 runner，逐条执行 + 良性错误跳过）
    println!("📋 步骤 2: 执行多租户表结构迁移...");
    let stats = run_sql_script(&pool, "003 management schema", SQL).await;
    if stats.has_error() {
        eprintln!(
            "\n❌ 多租户表结构迁移失败：执行 {}，跳过 {}，错误 {}",
            stats.ok, stats.skipped, stats.errors
        );
        std::process::exit(1);
    }
    println!(
        "✅ 多租户表结构创建成功（执行 {}，幂等跳过 {}）\n",
        stats.ok, stats.skipped
    );

    // 3. 确保 users 表有 role 字段，并把 admin 置为 super_admin
    println!("📋 步骤 3: 设置超级管理员...");

    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'")
        .execute(&pool)
        .await?;

    let admin_updated = sqlx::query(
        r#"
        UPDATE users
        SET role = 'super_admin'
        WHERE username = 'admin' OR email = 'admin@example.com'
        RETURNING id, username, role
        "#,
    )
    .fetch_optional(&pool)
    .await?;

    if let Some(row) = admin_updated {
        let username: String = row.get("username");
        let role: String = row.get("role");
        println!("✅ 超级管理员设置成功: {} ({})", username, role);
    } else {
        println!("⚠️  警告: 未找到 admin 用户，请先注册或运行 `cargo run --bin create_admin`");
    }

    println!("\n🎉 多租户系统配置完成！\n");
    println!("📝 接下来你可以：");
    println!("   1. 使用 admin 账号登录系统");
    println!("   2. 访问租户管理页面创建租户");
    println!("   3. 为租户配置数据库连接");
    println!("   4. 为租户添加用户\n");

    Ok(())
}
