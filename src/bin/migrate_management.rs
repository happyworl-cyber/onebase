//! 迁移脚本：多租户管理架构（management schema）
//!
//! 运行方式: `cargo run --bin migrate_management`

use onebase::migrate::run_sql_script;
use sqlx::{postgres::PgPoolOptions, Row};
use std::env;

const SQL: &str = include_str!("../../migrations/003_create_management_schema.sql");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    println!("🔌 连接到数据库: {}", database_url);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    println!("✅ 数据库连接成功\n");

    // 确保 management schema 存在
    sqlx::query("CREATE SCHEMA IF NOT EXISTS management")
        .execute(&pool)
        .await?;

    println!("📝 创建多租户管理架构...");
    let stats = run_sql_script(&pool, "003 management schema", SQL).await;
    if stats.has_error() {
        eprintln!(
            "\n❌ 迁移失败：执行 {}，跳过 {}，错误 {}",
            stats.ok, stats.skipped, stats.errors
        );
        std::process::exit(1);
    }
    println!(
        "✅ 多租户管理架构创建完成（执行 {}，幂等跳过 {}）\n",
        stats.ok, stats.skipped
    );

    // 配置用户角色系统
    println!("📝 配置用户角色系统...");
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'")
        .execute(&pool)
        .await?;

    let admin_updated = sqlx::query(
        r#"
        UPDATE users
        SET role = 'super_admin'
        WHERE username = 'admin' OR email = 'admin@example.com'
        RETURNING id, username, email, role
        "#,
    )
    .fetch_optional(&pool)
    .await?;

    if let Some(row) = admin_updated {
        let username: String = row.get("username");
        let email: String = row.get("email");
        let role: String = row.get("role");
        println!("✅ 超级管理员设置成功:");
        println!("   用户名: {}", username);
        println!("   邮箱:   {}", email);
        println!("   角色:   {}", role);
    } else {
        println!("⚠️  警告: 未找到 admin 用户");
        println!("   先 `cargo run --bin create_admin`，或手动执行：");
        println!("   UPDATE users SET role = 'super_admin' WHERE username = 'your_username';");
    }

    println!("\n📊 创建的管理表:");
    println!("   - management.tenants (租户)");
    println!("   - management.tenant_databases (数据库连接配置)");
    println!("   - management.tenant_schemas (业务 Schema)");
    println!("   - management.user_tenants (用户-租户关联)");
    println!("   - management.connection_access_logs (访问日志)");

    Ok(())
}
